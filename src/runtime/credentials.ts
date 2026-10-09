// Short-lived run credentials (architecture.md §6.7). Agents hold only this token; it names the run,
// task, employee, and lease epoch. The Tool Gateway re-checks the epoch against the ledger on every call.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface RunClaims { runId: string; employeeId: string; taskId: string | null; epoch: number; mode: 'task' | 'review' | 'conversation'; exp: number }

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class CredentialIssuer {
  constructor(private readonly secret: Buffer) {}

  static fromEnvOrFile(envName: string, storageDir: string): CredentialIssuer {
    const env = process.env[envName];
    if (env) return new CredentialIssuer(Buffer.from(env));
    const f = path.join(storageDir, 'credential.secret');
    if (!existsSync(f)) { mkdirSync(storageDir, { recursive: true }); writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600 }); }
    return new CredentialIssuer(Buffer.from(readFileSync(f, 'utf8').trim()));
  }

  issue(c: Omit<RunClaims, 'exp'>, ttlMs = 15 * 60_000): string {
    const body = b64(JSON.stringify({ ...c, exp: Date.now() + ttlMs }));
    return `${body}.${b64(createHmac('sha256', this.secret).update(body).digest())}`;
  }

  verify(token: string): RunClaims {
    const [body, sig] = token.split('.');
    if (!body || !sig) throw new Error('malformed credential');
    const expected = createHmac('sha256', this.secret).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('invalid credential signature');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as RunClaims;
    if (claims.exp < Date.now()) throw new Error('credential expired');
    return claims;
  }
}
