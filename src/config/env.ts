// Minimal .env loader: KEY=VALUE lines; existing environment variables win. Secrets stay out of
// config files and the ledger; `.env` is git-ignored.
import { existsSync, readFileSync } from 'node:fs';

export function loadDotEnv(file = '.env') {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const v = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = v;
  }
}
