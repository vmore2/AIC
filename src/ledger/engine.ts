// Transition Engine — the single writer of protected ledger state (INV-1).
// Pipeline per command, in ONE database transaction (architecture.md §7.4):
//   idempotency claim → handler (loads with row locks, authorizes via PDP, checks guards, mutates)
//   → append hash-chained events → enqueue outbox → record command outcome → commit.
import { chainHash, hashOf } from '../domain/hash.js';
import { newId } from '../domain/ids.js';
import type { Principal } from '../domain/types.js';
import type { AuthzContext, Pdp, PrincipalAttrs } from '../policy/pdp.js';
import { stripNul, type Db, type Queryable } from './db.js';

export type ErrorCode =
  | 'forbidden' | 'guard_failed' | 'not_found' | 'conflict' | 'validation'
  | 'idempotency_key_reuse' | 'precondition_failed' | 'stale_lease' | 'budget_exhausted';

export class DomainError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

export interface NewEvent {
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export interface CommandContext {
  q: Queryable;
  principal: Principal;
  now: Date;
  commandKey: string;
  emit(e: NewEvent): void;
  /** Authorize via the PDP; throws DomainError('forbidden') on deny. */
  authorize(action: string, resource: { type: string; id: string }, context: Partial<AuthzContext>): Promise<void>;
}

export type Handler<I, O> = (c: CommandContext, input: I) => Promise<O>;

export interface StoredEvent {
  seq: number; id: string; type: string; aggregate_type: string; aggregate_id: string;
  actor: Principal; payload: Record<string, unknown>; occurred_at: string; prev_hash: string; hash: string;
}

export class Engine {
  constructor(readonly db: Db, readonly pdp: Pdp, private readonly clock: () => Date = () => new Date()) {}

  /**
   * Execute a command. `idemKey` must be stable across retries of the same intent:
   * clients supply it; workflows derive it deterministically (§7.6).
   */
  async execute<I, O>(type: string, handler: Handler<I, O>, input: I, principal: Principal, idemKey: string): Promise<O> {
    const cmdSha = hashOf({ type, input, principal: { type: principal.type, id: principal.id } });
    try {
      return await this.db.tx(async (q) => {
        const prior = await q.query<{ command_sha256: string; status: string; outcome: { result?: O; error?: { code: ErrorCode; message: string; details: Record<string, unknown> } } }>(
          'SELECT command_sha256, status, outcome FROM command_log WHERE idem_key = $1', [idemKey]);
        const p = prior.rows[0];
        if (p) {
          if (p.command_sha256 !== cmdSha) throw new DomainError('idempotency_key_reuse', 'Idempotency key reused with a different command');
          if (p.status === 'rejected' && p.outcome.error) throw new DomainError(p.outcome.error.code, p.outcome.error.message, { ...p.outcome.error.details, replayed: true });
          return p.outcome.result as O; // INV-8: replay returns the original outcome
        }

        const events: NewEvent[] = [];
        const now = this.clock();
        const ctx: CommandContext = {
          q, principal, now, commandKey: idemKey,
          emit: (e) => { events.push(e); },
          authorize: async (action, resource, context) => {
            const attrs = await this.principalAttrs(q, principal);
            const d = this.pdp.authorize({ principal, attrs, action, resource, context });
            if (!d.allowed) throw new DomainError('forbidden', `Policy denied ${action} on ${resource.type}::${resource.id}`, { reasons: d.reasons, errors: d.errors, action });
          },
        };
        const result = await handler(ctx, input);
        await appendEvents(q, events, principal, idemKey, now);
        await q.query('INSERT INTO command_log (idem_key, command_type, command_sha256, principal, status, outcome) VALUES ($1,$2,$3,$4,$5,$6)',
          [idemKey, type, cmdSha, JSON.stringify(principal), 'done', JSON.stringify({ result: result ?? null })]);
        return result;
      });
    } catch (e) {
      if (e instanceof DomainError && e.details['replayed'] !== true && e.code !== 'idempotency_key_reuse') {
        // Record the rejection durably in its own transaction (audit of denials and guard failures).
        await this.recordRejection(type, cmdSha, principal, idemKey, e).catch(() => undefined);
      }
      throw e;
    }
  }

  private async recordRejection(type: string, cmdSha: string, principal: Principal, idemKey: string, e: DomainError) {
    await this.db.tx(async (q) => {
      const ins = await q.query(
        `INSERT INTO command_log (idem_key, command_type, command_sha256, principal, status, outcome)
         VALUES ($1,$2,$3,$4,'rejected',$5) ON CONFLICT (idem_key) DO NOTHING RETURNING idem_key`,
        [idemKey, type, cmdSha, JSON.stringify(principal), JSON.stringify({ error: { code: e.code, message: e.message, details: e.details } })]);
      if (ins.rows.length) {
        await appendEvents(q, [{ type: e.code === 'forbidden' ? 'command.denied' : 'command.rejected', aggregateType: 'command', aggregateId: idemKey,
          payload: { command: type, code: e.code, message: e.message, details: e.details } }], principal, idemKey, this.clock());
      }
    });
  }

  private async principalAttrs(q: Queryable, p: Principal): Promise<PrincipalAttrs> {
    if (p.type === 'user') {
      const r = await q.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [p.id]);
      return { role: r.rows[0]?.role ?? 'none', can_manage: false, step_up: !!p.stepUp };
    }
    if (p.type === 'employee') {
      const r = await q.query<{ role_key: string; can_manage: boolean; status: string }>('SELECT role_key, can_manage, status FROM employees WHERE id = $1', [p.id]);
      const row = r.rows[0];
      if (!row || row.status !== 'active') return { role: 'inactive', can_manage: false, step_up: false };
      return { role: row.role_key, can_manage: row.can_manage, step_up: false };
    }
    return { role: 'system', can_manage: false, step_up: false };
  }

  /** Read events after a sequence number (used by the outbox relay and audit views). */
  async eventsAfter(seq: number, limit = 500): Promise<StoredEvent[]> {
    return (await this.db.query<StoredEvent>('SELECT * FROM ledger_events WHERE seq > $1 ORDER BY seq LIMIT $2', [seq, limit])).rows
      .map((r) => ({ ...r, seq: Number(r.seq) }));
  }
}

/** Append events to the hash chain and the outbox (INV-9, INV-10). */
async function appendEvents(q: Queryable, events: NewEvent[], principal: Principal, commandKey: string, now: Date) {
  if (!events.length) return;
  const head = (await q.query<{ last_seq: string; last_hash: string }>('SELECT last_seq, last_hash FROM chain_head WHERE id = 1 FOR UPDATE')).rows[0]!;
  let seq = Number(head.last_seq);
  let prev = head.last_hash;
  for (const e of events) {
    seq += 1;
    const id = newId('evt');
    const occurredAt = now.toISOString();
    // Hash exactly what is stored: the database layer strips NUL characters, so strip them first here.
    const payload = stripNul(e.payload);
    const body = { seq, id, type: e.type, aggregate_type: e.aggregateType, aggregate_id: e.aggregateId, actor: principal, payload, occurred_at: occurredAt };
    const hash = chainHash(prev, body);
    await q.query(
      `INSERT INTO ledger_events (seq, id, type, aggregate_type, aggregate_id, command_key, actor, payload, occurred_at, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [seq, id, e.type, e.aggregateType, e.aggregateId, commandKey, JSON.stringify(principal), JSON.stringify(payload), occurredAt, prev, hash]);
    await q.query('INSERT INTO outbox (event_seq, event_type, aggregate_id) VALUES ($1,$2,$3)', [seq, e.type, e.aggregateId]);
    prev = hash;
  }
  await q.query('UPDATE chain_head SET last_seq = $1, last_hash = $2 WHERE id = 1', [seq, prev]);
}

/** Recompute the hash chain; returns the first broken sequence number or null (audit verifier). */
export async function verifyChain(db: Queryable): Promise<{ ok: boolean; brokenAt: number | null; checked: number }> {
  const rows = (await db.query<StoredEvent>('SELECT * FROM ledger_events ORDER BY seq')).rows;
  let prev = '0'.repeat(64);
  for (const r of rows) {
    const occurred = new Date(r.occurred_at).toISOString();
    const body = { seq: Number(r.seq), id: r.id, type: r.type, aggregate_type: r.aggregate_type, aggregate_id: r.aggregate_id, actor: r.actor, payload: r.payload, occurred_at: occurred };
    if (r.prev_hash !== prev || chainHash(prev, body) !== r.hash) return { ok: false, brokenAt: Number(r.seq), checked: rows.length };
    prev = r.hash;
  }
  return { ok: true, brokenAt: null, checked: rows.length };
}
