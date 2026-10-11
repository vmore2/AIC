// Secret vault in the CUSTOMER's storage (architecture.md §16.5). Model API keys and connection
// credentials the CEO enters in the dashboard are encrypted here (AES-256-GCM, one IV per secret, the
// secret id bound as additional authenticated data). The ledger only ever stores a secret's id and a
// non-reversible fingerprint; agents never receive secret values — the platform uses them on their behalf.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { newId } from '../domain/ids.js';

interface Sealed { iv: string; tag: string; data: string; label: string; created_at: string }
interface VaultFile { version: 1; secrets: Record<string, Sealed> }

/** A short, non-reversible label for showing a secret back to people ("sk-…a1b2 · 3f9c"). */
export function fingerprint(value: string): string {
  const v = value.trim();
  const hint = v.length > 12 ? `${v.slice(0, 3)}…${v.slice(-4)}` : '••••';
  return `${hint} · ${createHash('sha256').update(v).digest('hex').slice(0, 4)}`;
}

export class SecretVault {
  private constructor(private readonly file: string, private readonly key: Buffer) {}

  /** Master key from the environment (32 bytes, base64 or hex) or generated once into storage. */
  static open(storagePath: string, masterKey?: string): SecretVault {
    mkdirSync(storagePath, { recursive: true });
    let key: Buffer;
    if (masterKey) {
      key = /^[0-9a-f]{64}$/i.test(masterKey) ? Buffer.from(masterKey, 'hex') : Buffer.from(masterKey, 'base64');
      if (key.length !== 32) throw new Error('AIC_MASTER_KEY must be 32 bytes (64 hex characters or base64)');
    } else {
      const kf = path.join(storagePath, 'master.key');
      if (!existsSync(kf)) writeFileSync(kf, randomBytes(32).toString('hex'), { mode: 0o600 });
      key = Buffer.from(readFileSync(kf, 'utf8').trim(), 'hex');
    }
    return new SecretVault(path.join(storagePath, 'secrets.vault.json'), key);
  }

  private read(): VaultFile {
    if (!existsSync(this.file)) return { version: 1, secrets: {} };
    return JSON.parse(readFileSync(this.file, 'utf8')) as VaultFile;
  }
  private write(v: VaultFile) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(v, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Store a secret (a string or a small map of fields); returns its id. */
  put(value: string | Record<string, string>, label: string, id = newId('sec')): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(id));
    const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    const v = this.read();
    v.secrets[id] = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64'), label, created_at: new Date().toISOString() };
    this.write(v);
    return id;
  }

  get<T extends string | Record<string, string> = string>(id: string): T {
    const s = this.read().secrets[id];
    if (!s) throw new Error(`Secret ${id} is not in the vault`);
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(s.iv, 'base64'));
    d.setAAD(Buffer.from(id));
    d.setAuthTag(Buffer.from(s.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, 'base64')), d.final()]).toString('utf8')) as T;
  }

  has(id: string): boolean { return id in this.read().secrets; }

  delete(id: string) {
    const v = this.read();
    if (id in v.secrets) { delete v.secrets[id]; this.write(v); }
  }
}
