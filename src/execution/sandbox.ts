// Sandbox port (architecture.md §16.7). Agent-run commands (tests, builds, scripts) execute here.
//  - DockerSandbox: each command in a fresh, locked-down container (no network, no capabilities,
//    read-only root, non-root user, CPU/memory/PID limits). Uses the customer's own Docker.
//  - LocalProcessSandbox: plain child process with scrubbed env + timeouts. NOT isolated;
//    local evaluation on a trusted machine only, and refuses to run unless explicitly allowed.
// Microvm/gVisor sandboxes (E2B, Kubernetes Agent Sandbox) implement the same port.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface ExecResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
export interface SandboxPort { readonly isolated: boolean; readonly description: string; exec(cwd: string, command: string, timeoutMs: number): Promise<ExecResult> }

const MAX_OUTPUT = 64 * 1024;

function runProcess(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; shell?: boolean }, timeoutMs: number, onTimeout?: () => void): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, shell: opts.shell ?? false, windowsHide: true });
    let stdout = ''; let stderr = ''; let timedOut = false;
    const cap = (buf: string, chunk: Buffer) => (buf.length < MAX_OUTPUT ? buf + chunk.toString('utf8') : buf);
    child.stdout.on('data', (d: Buffer) => { stdout = cap(stdout, d); });
    child.stderr.on('data', (d: Buffer) => { stderr = cap(stderr, d); });
    const timer = setTimeout(() => { timedOut = true; onTimeout?.(); child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), timedOut }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: null, stdout, stderr: String(e), timedOut }); });
  });
}

export class LocalProcessSandbox implements SandboxPort {
  readonly isolated = false;
  constructor(private readonly allowUnisolated: boolean) {}
  get description() { return this.allowUnisolated ? 'local processes (NOT isolated; evaluation only)' : 'no sandbox configured'; }

  exec(cwd: string, command: string, timeoutMs: number): Promise<ExecResult> {
    if (!this.allowUnisolated) {
      return Promise.resolve({ exitCode: null, stdout: '', stderr: 'Sandbox unavailable: configure sandbox.kind: docker (or your isolated sandbox). Local unisolated execution is disabled.', timedOut: false });
    }
    // Scrubbed environment: no inherited secrets (API keys, tokens) reach agent-executed code.
    const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '', TEMP: process.env['TEMP'] ?? '', TMP: process.env['TMP'] ?? '', HOME: cwd, CI: '1', NO_COLOR: '1' };
    return runProcess(command, [], { cwd, env, shell: true }, timeoutMs);
  }
}

export interface DockerSandboxOptions { image: string; memory: string; cpus: number; pids: number; network: 'none' | 'bridge'; dockerBin?: string }

export class DockerSandbox implements SandboxPort {
  readonly isolated = true;
  constructor(private readonly o: DockerSandboxOptions) {}
  get description() { return `Docker (${this.o.image}, network ${this.o.network}, ${this.o.memory} RAM, ${this.o.cpus} CPU, read-only root, no capabilities)`; }

  /** The exact `docker run` arguments: the security posture of every agent command, in one place. */
  args(cwd: string, command: string, name: string): string[] {
    return [
      'run', '--rm', '--name', name,
      '--network', this.o.network,
      '--memory', this.o.memory, '--memory-swap', this.o.memory,
      '--cpus', String(this.o.cpus), '--pids-limit', String(this.o.pids),
      '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', '1000:1000',
      '-e', 'HOME=/tmp', '-e', 'CI=1', '-e', 'NO_COLOR=1',
      '-v', `${cwd}:/workspace:rw`, '-w', '/workspace',
      this.o.image, 'sh', '-c', command,
    ];
  }

  async exec(cwd: string, command: string, timeoutMs: number): Promise<ExecResult> {
    const name = `aic-sbx-${randomBytes(6).toString('hex')}`;
    const bin = this.o.dockerBin ?? 'docker';
    return runProcess(bin, this.args(cwd, command, name), {}, timeoutMs, () => { spawn(bin, ['kill', name], { windowsHide: true }).on('error', () => undefined); });
  }
}
