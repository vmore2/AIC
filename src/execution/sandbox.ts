// Sandbox port (architecture.md §16.7). Production deployments must plug in an isolated
// implementation (Firecracker microVMs, gVisor/Kata via Kubernetes Agent Sandbox, or the
// customer's equivalent). The LocalProcessSandbox below is for local evaluation only:
// it runs commands as a child process with a timeout, scrubbed environment, and output caps,
// but it does NOT isolate the host. It refuses to run unless explicitly allowed.
import { spawn } from 'node:child_process';

export interface ExecResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }
export interface SandboxPort { readonly isolated: boolean; exec(cwd: string, command: string, timeoutMs: number): Promise<ExecResult> }

const MAX_OUTPUT = 64 * 1024;

export class LocalProcessSandbox implements SandboxPort {
  readonly isolated = false;
  constructor(private readonly allowUnisolated: boolean) {}

  exec(cwd: string, command: string, timeoutMs: number): Promise<ExecResult> {
    if (!this.allowUnisolated) {
      return Promise.resolve({ exitCode: null, stdout: '', stderr: 'Sandbox unavailable: no isolated sandbox configured (set sandbox.allow_unisolated_local for local evaluation only).', timedOut: false });
    }
    return new Promise((resolve) => {
      // Scrubbed environment: no inherited secrets (API keys, tokens) reach agent-executed code.
      const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '', TEMP: process.env['TEMP'] ?? '', TMP: process.env['TMP'] ?? '', HOME: cwd, CI: '1', NO_COLOR: '1' };
      const child = spawn(command, { cwd, shell: true, env, windowsHide: true });
      let stdout = ''; let stderr = ''; let timedOut = false;
      const cap = (buf: string, chunk: Buffer) => (buf.length < MAX_OUTPUT ? buf + chunk.toString('utf8') : buf);
      child.stdout.on('data', (d: Buffer) => { stdout = cap(stdout, d); });
      child.stderr.on('data', (d: Buffer) => { stderr = cap(stderr, d); });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), timedOut }); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ exitCode: null, stdout, stderr: String(e), timedOut }); });
    });
  }
}
