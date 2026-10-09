import { randomBytes, createHash } from 'node:crypto';

/** UUIDv7-style, time-ordered identifier with a type prefix, e.g. `tsk_0192f…`. */
export function newId(prefix: string, now: number = Date.now()): string {
  const ts = now.toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${prefix}_${ts}${rand}`;
}

/** Deterministic id for reactions so that replays produce the same idempotency key. */
export function deterministicKey(...parts: (string | number)[]): string {
  return createHash('sha256').update(parts.join('␟')).digest('hex').slice(0, 40);
}
