import { createHash } from 'node:crypto';

/** Canonical JSON: object keys sorted recursively, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export const hashOf = (value: unknown): string => sha256Hex(canonicalJson(value));

export const GENESIS_HASH = '0'.repeat(64);

/** hash_n = SHA-256(hash_{n-1} ‖ canonical(event_n)) — architecture.md §16.8 */
export function chainHash(prevHash: string, event: unknown): string {
  return sha256Hex(prevHash + canonicalJson(event));
}
