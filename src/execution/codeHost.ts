// Code/deliverable hosting. Every department's deliverables are versioned files in a git
// repository the CEO provides (a local repo for evaluation, or their GitHub repo).
// Artifacts are identified by commit SHA and tree hash, so evidence binds to exact content.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { GitHubApi } from './github.js';

const run = promisify(execFile);

/** Strip credentials from anything git prints (command lines in errors, URLs, auth headers). */
export function redactSecrets(s: string): string {
  return s.replace(/(https?:\/\/)[^/\s@]+@/g, '$1***@')
    .replace(/\b(github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '$1***')
    .replace(/(authorization:\s*\w+\s+)\S+/gi, '$1***');
}

export async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    return stdout.trim();
  } catch (e) {
    // execFile errors embed the full command line and stderr; never let a credential escape into the ledger or logs.
    const err = e as Error & { stderr?: string; stdout?: string };
    throw Object.assign(new Error(redactSecrets(err.message)), { stderr: redactSecrets(String(err.stderr ?? '')), stdout: redactSecrets(String(err.stdout ?? '')) });
  }
}

export interface CodeHost {
  readonly description: string;
  readonly baseBranch: string;
  /** Remote URL used for clones and pushes. Contains NO credentials (it is stored in each clone's .git/config). */
  remote(): string;
  /** Per-command git environment carrying credentials (never written to disk, never visible to agents). */
  gitEnv(): Record<string, string>;
  ensure(): Promise<void>;
}

export class LocalCodeHost implements CodeHost {
  readonly baseBranch = 'main';
  constructor(readonly repoPath: string) {}
  get description() { return `local repository at ${this.repoPath}`; }
  remote() { return this.repoPath; }
  gitEnv() { return {}; }

  /** Create a bare repository with an initial commit if it does not exist yet. */
  async ensure() {
    if (existsSync(path.join(this.repoPath, 'HEAD')) || existsSync(path.join(this.repoPath, '.git'))) return;
    mkdirSync(this.repoPath, { recursive: true });
    await git(this.repoPath, ['init', '--bare', '--initial-branch=main']);
    const seed = `${this.repoPath}.seed`;
    rmSync(seed, { recursive: true, force: true });
    mkdirSync(seed, { recursive: true });
    await git(seed, ['init', '--initial-branch=main']);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(seed, 'README.md'), '# Company deliverables\n\nManaged by The AI Company. Work happens on aic/* branches; accepted work is merged into objective integration branches.\n');
    await git(seed, ['add', '-A']);
    await git(seed, ['-c', 'user.name=The AI Company', '-c', 'user.email=platform@aic.local', 'commit', '-m', 'Initialize deliverables repository']);
    await git(seed, ['push', this.repoPath, 'main']);
    rmSync(seed, { recursive: true, force: true });
  }
}

export class GitHubCodeHost implements CodeHost {
  constructor(readonly repo: string, readonly tokenEnv: string, readonly baseBranch = 'main', readonly apiUrl = 'https://api.github.com') {}
  api(): GitHubApi {
    const token = process.env[this.tokenEnv];
    if (!token) throw new Error(`${this.tokenEnv} is not set`);
    return new GitHubApi(this.repo, token, this.apiUrl);
  }
  get description() { return `GitHub ${this.repo}`; }
  remote() { return `https://github.com/${this.repo}.git`; }
  /** The token travels as an HTTP header via git's environment config, so it never lands in .git/config. */
  gitEnv() {
    const token = process.env[this.tokenEnv];
    if (!token) throw new Error(`${this.tokenEnv} is not set`);
    return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` };
  }
  async ensure() { /* repository is provided by the customer */ }
}

export interface Workspace { dir: string; branch: string }

/** Workspaces live in customer storage; each run gets a fresh clone on its own branch namespace (§7.7). */
export class Workspaces {
  constructor(readonly host: CodeHost, readonly root: string) {}
  private git(cwd: string, args: string[]): Promise<string> { return git(cwd, args, this.host.gitEnv()); }

  integrationBranch(objectiveId: string) { return `aic/${objectiveId}/integration`; }

  async refExists(ref: string): Promise<boolean> {
    mkdirSync(this.root, { recursive: true });
    try { await this.git(this.root, ['ls-remote', '--exit-code', this.host.remote(), ref]); return true; } catch { return false; }
  }

  async remoteSha(ref: string): Promise<string | null> {
    mkdirSync(this.root, { recursive: true });
    try {
      const out = await this.git(this.root, ['ls-remote', this.host.remote(), ref]);
      return out.split(/\s+/)[0] || null;
    } catch { return null; }
  }

  async createForRun(runId: string, objectiveId: string, taskId: string): Promise<Workspace> {
    mkdirSync(this.root, { recursive: true });
    const dir = path.join(this.root, 'runs', runId);
    rmSync(dir, { recursive: true, force: true });
    const integration = this.integrationBranch(objectiveId);
    const base = (await this.refExists(`refs/heads/${integration}`)) ? integration : this.host.baseBranch;
    await this.git(this.root, ['clone', '--quiet', '--branch', base, this.host.remote(), dir]);
    const branch = `aic/${taskId}/${runId}`;
    await this.git(dir, ['checkout', '-q', '-b', branch]);
    return { dir, branch };
  }

  /** Commit everything and push the run branch. Returns the commit SHA and tree hash. */
  async commitAndPush(ws: Workspace, message: string, author: { name: string; email: string }): Promise<{ sha: string; tree: string; changed: boolean }> {
    await this.git(ws.dir, ['add', '-A']);
    const status = await this.git(ws.dir, ['status', '--porcelain']);
    if (status) await this.git(ws.dir, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '-m', message]);
    await this.git(ws.dir, ['push', '-q', 'origin', `HEAD:refs/heads/${ws.branch}`]);
    return { sha: await this.git(ws.dir, ['rev-parse', 'HEAD']), tree: await this.git(ws.dir, ['rev-parse', 'HEAD^{tree}']), changed: !!status };
  }

  /** A fresh, independent checkout of an exact commit for verification (never the producer's workspace). */
  async checkoutForVerification(sha: string, label: string): Promise<string> {
    const dir = path.join(this.root, 'verify', `${label}-${sha.slice(0, 12)}-${Date.now()}`);
    mkdirSync(path.dirname(dir), { recursive: true });
    await this.git(this.root, ['clone', '--quiet', '--no-checkout', this.host.remote(), dir]);
    await this.git(dir, ['checkout', '-q', '--detach', sha]);
    return dir;
  }

  async commitExistsOnBranch(sha: string, branch: string): Promise<boolean> {
    const dir = path.join(this.root, 'probe');
    if (!existsSync(dir)) await this.git(this.root, ['clone', '--quiet', '--bare', this.host.remote(), dir]);
    else await this.git(dir, ['fetch', '-q', 'origin', '+refs/heads/*:refs/heads/*']).catch(() => this.git(dir, ['fetch', '-q', this.host.remote(), '+refs/heads/*:refs/heads/*']));
    try { await this.git(dir, ['merge-base', '--is-ancestor', sha, `refs/heads/${branch}`]); return true; } catch { return false; }
  }

  async treeOf(sha: string): Promise<string> {
    const dir = path.join(this.root, 'probe');
    return this.git(dir, ['rev-parse', `${sha}^{tree}`]);
  }

  /** Platform-performed merge of accepted work into the objective integration branch. */
  async mergeIntoIntegration(objectiveId: string, sha: string, message: string): Promise<{ ok: boolean; sha?: string; error?: string }> {
    const dir = path.join(this.root, 'integration', objectiveId);
    rmSync(dir, { recursive: true, force: true });
    const integration = this.integrationBranch(objectiveId);
    const exists = await this.refExists(`refs/heads/${integration}`);
    await this.git(this.root, ['clone', '--quiet', '--branch', exists ? integration : this.host.baseBranch, this.host.remote(), dir]);
    if (!exists) await this.git(dir, ['checkout', '-q', '-b', integration]);
    try {
      await this.git(dir, ['fetch', '-q', 'origin', sha]).catch(() => undefined);
      await this.git(dir, ['-c', 'user.name=The AI Company', '-c', 'user.email=platform@aic.local', 'merge', '--no-ff', '-q', '-m', message, sha]);
    } catch (e) {
      await this.git(dir, ['merge', '--abort']).catch(() => undefined);
      return { ok: false, error: (e as Error).message.slice(0, 500) };
    }
    await this.git(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${integration}`]);
    return { ok: true, sha: await this.git(dir, ['rev-parse', 'HEAD']) };
  }

  async showFile(sha: string, file: string): Promise<string | null> {
    const dir = path.join(this.root, 'probe');
    try { return await this.git(dir, ['show', `${sha}:${file.replace(/\\/g, '/')}`]); } catch { return null; }
  }

  async diffAgainstBase(sha: string, objectiveId: string): Promise<string> {
    const dir = path.join(this.root, 'probe');
    const integration = this.integrationBranch(objectiveId);
    const base = (await this.refExists(`refs/heads/${integration}`)) ? integration : this.host.baseBranch;
    try { return await this.git(dir, ['diff', `refs/heads/${base}...${sha}`]); } catch { return ''; }
  }
}
