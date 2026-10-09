// Code/deliverable hosting. Every department's deliverables are versioned files in a git
// repository the CEO provides (a local repo for evaluation, or their GitHub repo).
// Artifacts are identified by commit SHA and tree hash, so evidence binds to exact content.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

export interface CodeHost {
  readonly description: string;
  readonly baseBranch: string;
  /** Remote URL used for clones and pushes (credentials injected here, never given to agents). */
  remote(): string;
  ensure(): Promise<void>;
}

export class LocalCodeHost implements CodeHost {
  readonly baseBranch = 'main';
  constructor(readonly repoPath: string) {}
  get description() { return `local repository at ${this.repoPath}`; }
  remote() { return this.repoPath; }

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
  constructor(readonly repo: string, readonly tokenEnv: string, readonly baseBranch = 'main') {}
  get description() { return `GitHub ${this.repo}`; }
  remote() {
    const token = process.env[this.tokenEnv];
    if (!token) throw new Error(`${this.tokenEnv} is not set`);
    return `https://x-access-token:${token}@github.com/${this.repo}.git`;
  }
  async ensure() { /* repository is provided by the customer */ }
}

export interface Workspace { dir: string; branch: string }

/** Workspaces live in customer storage; each run gets a fresh clone on its own branch namespace (§7.7). */
export class Workspaces {
  constructor(readonly host: CodeHost, readonly root: string) {}

  integrationBranch(objectiveId: string) { return `aic/${objectiveId}/integration`; }

  async refExists(ref: string): Promise<boolean> {
    try { await git(this.root, ['ls-remote', '--exit-code', this.host.remote(), ref]); return true; } catch { return false; }
  }

  async remoteSha(ref: string): Promise<string | null> {
    try {
      const out = await git(this.root, ['ls-remote', this.host.remote(), ref]);
      return out.split(/\s+/)[0] || null;
    } catch { return null; }
  }

  async createForRun(runId: string, objectiveId: string, taskId: string): Promise<Workspace> {
    mkdirSync(this.root, { recursive: true });
    const dir = path.join(this.root, 'runs', runId);
    rmSync(dir, { recursive: true, force: true });
    const integration = this.integrationBranch(objectiveId);
    const base = (await this.refExists(`refs/heads/${integration}`)) ? integration : this.host.baseBranch;
    await git(this.root, ['clone', '--quiet', '--branch', base, this.host.remote(), dir]);
    const branch = `aic/${taskId}/${runId}`;
    await git(dir, ['checkout', '-q', '-b', branch]);
    return { dir, branch };
  }

  /** Commit everything and push the run branch. Returns the commit SHA and tree hash. */
  async commitAndPush(ws: Workspace, message: string, author: { name: string; email: string }): Promise<{ sha: string; tree: string; changed: boolean }> {
    await git(ws.dir, ['add', '-A']);
    const status = await git(ws.dir, ['status', '--porcelain']);
    if (status) await git(ws.dir, ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, 'commit', '-q', '-m', message]);
    await git(ws.dir, ['push', '-q', 'origin', `HEAD:refs/heads/${ws.branch}`]);
    return { sha: await git(ws.dir, ['rev-parse', 'HEAD']), tree: await git(ws.dir, ['rev-parse', 'HEAD^{tree}']), changed: !!status };
  }

  /** A fresh, independent checkout of an exact commit for verification (never the producer's workspace). */
  async checkoutForVerification(sha: string, label: string): Promise<string> {
    const dir = path.join(this.root, 'verify', `${label}-${sha.slice(0, 12)}-${Date.now()}`);
    mkdirSync(path.dirname(dir), { recursive: true });
    await git(this.root, ['clone', '--quiet', '--no-checkout', this.host.remote(), dir]);
    await git(dir, ['checkout', '-q', '--detach', sha]);
    return dir;
  }

  async commitExistsOnBranch(sha: string, branch: string): Promise<boolean> {
    const dir = path.join(this.root, 'probe');
    if (!existsSync(dir)) await git(this.root, ['clone', '--quiet', '--bare', this.host.remote(), dir]);
    else await git(dir, ['fetch', '-q', 'origin', '+refs/heads/*:refs/heads/*']).catch(() => git(dir, ['fetch', '-q', this.host.remote(), '+refs/heads/*:refs/heads/*']));
    try { await git(dir, ['merge-base', '--is-ancestor', sha, `refs/heads/${branch}`]); return true; } catch { return false; }
  }

  async treeOf(sha: string): Promise<string> {
    const dir = path.join(this.root, 'probe');
    return git(dir, ['rev-parse', `${sha}^{tree}`]);
  }

  /** Platform-performed merge of accepted work into the objective integration branch. */
  async mergeIntoIntegration(objectiveId: string, sha: string, message: string): Promise<{ ok: boolean; sha?: string; error?: string }> {
    const dir = path.join(this.root, 'integration', objectiveId);
    rmSync(dir, { recursive: true, force: true });
    const integration = this.integrationBranch(objectiveId);
    const exists = await this.refExists(`refs/heads/${integration}`);
    await git(this.root, ['clone', '--quiet', '--branch', exists ? integration : this.host.baseBranch, this.host.remote(), dir]);
    if (!exists) await git(dir, ['checkout', '-q', '-b', integration]);
    try {
      await git(dir, ['fetch', '-q', 'origin', sha]).catch(() => undefined);
      await git(dir, ['-c', 'user.name=The AI Company', '-c', 'user.email=platform@aic.local', 'merge', '--no-ff', '-q', '-m', message, sha]);
    } catch (e) {
      await git(dir, ['merge', '--abort']).catch(() => undefined);
      return { ok: false, error: (e as Error).message.slice(0, 500) };
    }
    await git(dir, ['push', '-q', 'origin', `HEAD:refs/heads/${integration}`]);
    return { ok: true, sha: await git(dir, ['rev-parse', 'HEAD']) };
  }

  async showFile(sha: string, file: string): Promise<string | null> {
    const dir = path.join(this.root, 'probe');
    try { return await git(dir, ['show', `${sha}:${file.replace(/\\/g, '/')}`]); } catch { return null; }
  }

  async diffAgainstBase(sha: string, objectiveId: string): Promise<string> {
    const dir = path.join(this.root, 'probe');
    const integration = this.integrationBranch(objectiveId);
    const base = (await this.refExists(`refs/heads/${integration}`)) ? integration : this.host.baseBranch;
    try { return await git(dir, ['diff', `refs/heads/${base}...${sha}`]); } catch { return ''; }
  }
}
