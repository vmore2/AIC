// Emergency stop, resume, and external-action records (§7.9, §12.6).
import { hashOf } from '../../domain/hash.js';
import { newId } from '../../domain/ids.js';
import type { Mode } from '../../domain/types.js';
import { DomainError, type Handler } from '../engine.js';
import { getTask } from '../store.js';

type Scope = { type: 'company' | 'department' | 'objective'; id: string };

async function tasksInScope(q: { query: <T>(s: string, p?: unknown[]) => Promise<{ rows: T[] }> }, scope: Scope): Promise<string[]> {
  const sql = scope.type === 'company' ? `SELECT id FROM tasks`
    : scope.type === 'department' ? `SELECT t.id FROM tasks t JOIN objectives o ON o.id = t.objective_id WHERE o.department_id = $1`
    : `SELECT id FROM tasks WHERE objective_id = $1`;
  return (await q.query<{ id: string }>(sql, scope.type === 'company' ? [] : [scope.id])).rows.map((r) => r.id);
}

export const emergencyStop: Handler<{ scope: Scope; reason: string }, { heldTasks: number; revokedLeases: number; interruptedRuns: string[] }> = async (c, i) => {
  await c.authorize('emergency.stop', { type: 'Scope', id: `${i.scope.type}:${i.scope.id}` }, { action_class: 'A6' });
  const ids = await tasksInScope(c.q, i.scope);
  await c.q.query(
    `INSERT INTO mode_settings (scope_type, scope_id, mode, set_by, reason) VALUES ($1,$2,'M6',$3,$4)
     ON CONFLICT (scope_type, scope_id) DO UPDATE SET mode='M6', set_by=$3, reason=$4, set_at=now(), version=mode_settings.version+1`,
    [i.scope.type, i.scope.id, c.principal.id, `EMERGENCY STOP: ${i.reason}`]);
  let held = 0; let revoked = 0;
  const interrupted: string[] = [];
  for (const id of ids) {
    const t = await getTask(c.q, id, true);
    if (['accepted', 'cancelled', 'superseded'].includes(t.status)) continue;
    await c.q.query(`UPDATE tasks SET hold = 'e_stop', version = version + 1 WHERE id = $1`, [id]);
    held++;
    const l = await c.q.query<{ epoch: string; state: string; run_id: string | null }>('SELECT * FROM task_leases WHERE task_id = $1 FOR UPDATE', [id]);
    const lease = l.rows[0];
    if (lease && (lease.state === 'active' || lease.state === 'suspended')) {
      await c.q.query(`UPDATE task_leases SET state = 'revoked', epoch = epoch + 1 WHERE task_id = $1`, [id]); // fences every in-flight run (INV-7)
      revoked++;
      if (lease.run_id) interrupted.push(lease.run_id);
    }
    c.emit({ type: 'task.hold_changed', aggregateType: 'task', aggregateId: id, payload: { hold: 'e_stop', reason: i.reason } });
  }
  c.emit({ type: 'emergency_stop.initiated', aggregateType: 'scope', aggregateId: `${i.scope.type}:${i.scope.id}`, payload: { reason: i.reason, held, revoked, interrupted } });
  return { heldTasks: held, revokedLeases: revoked, interruptedRuns: interrupted };
};

export const resumeScope: Handler<{ scope: Scope; mode: Mode; acknowledgeUnresolvedActions: boolean; reason: string }, { released: number }> = async (c, i) => {
  await c.authorize('scope.resume', { type: 'Scope', id: `${i.scope.type}:${i.scope.id}` }, { action_class: 'A6' });
  if (i.mode === 'M6') throw new DomainError('validation', 'Resume needs a non-paused mode');
  const ids = await tasksInScope(c.q, i.scope);
  const unresolved = (await c.q.query<{ id: string; status: string }>(
    `SELECT id, status FROM external_actions WHERE task_id = ANY($1::text[]) AND status IN ('attempting','unknown','uncertain')`, [ids])).rows;
  if (unresolved.length && !i.acknowledgeUnresolvedActions)
    throw new DomainError('guard_failed', `${unresolved.length} external action(s) are unresolved; review the reconciliation report and acknowledge to resume`, { unresolved });
  const r = await c.q.query<{ id: string }>(`UPDATE tasks SET hold = NULL, version = version + 1 WHERE id = ANY($1::text[]) AND hold IN ('e_stop','mode_pause') RETURNING id`, [ids]);
  await c.q.query(`UPDATE mode_settings SET mode = $3, set_by = $4, reason = $5, set_at = now(), version = version + 1 WHERE scope_type = $1 AND scope_id = $2`,
    [i.scope.type, i.scope.id, i.mode, c.principal.id, `resume: ${i.reason}`]);
  for (const row of r.rows) c.emit({ type: 'task.hold_changed', aggregateType: 'task', aggregateId: row.id, payload: { hold: null, reason: 'resumed' } });
  c.emit({ type: 'scope.resumed', aggregateType: 'scope', aggregateId: `${i.scope.type}:${i.scope.id}`, payload: { mode: i.mode, released: r.rows.length, acknowledged_unresolved: unresolved.map((u) => u.id) } });
  return { released: r.rows.length };
};

// ---- External actions: intent → attempt → outcome → reconcile (INV-11). Written by the Tool Gateway / executors.

export const recordActionIntent: Handler<{ taskId: string; runId: string | null; epoch: number; connector: string; action: string; actionClass: string;
  idempotencyMode: 'native_key' | 'natural_key' | 'none'; naturalKey?: string; payload: Record<string, unknown>; approvalId?: string }, { actionId: string; idempotencyKey: string }> = async (c, i) => {
  await c.authorize('action.record', { type: 'Task', id: i.taskId }, {});
  const actionId = newId('act');
  const idempotencyKey = `${i.connector}:${i.action}:${actionId}`;
  await c.q.query(`INSERT INTO external_actions (id, task_id, run_id, lease_epoch, connector, action, action_class, idempotency_mode, idempotency_key, natural_key, payload, payload_sha256, approval_id, status)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'intended')`,
    [actionId, i.taskId, i.runId, i.epoch, i.connector, i.action, i.actionClass, i.idempotencyMode, idempotencyKey, i.naturalKey ?? null, JSON.stringify(i.payload), hashOf(i.payload), i.approvalId ?? null]);
  c.emit({ type: 'action.intended', aggregateType: 'external_action', aggregateId: actionId, payload: { task_id: i.taskId, connector: i.connector, action: i.action, class: i.actionClass } });
  return { actionId, idempotencyKey };
};

const ALLOWED_NEXT: Record<string, string[]> = {
  intended: ['attempting', 'cancelled'],
  attempting: ['succeeded', 'failed', 'unknown'],
  unknown: ['succeeded', 'failed', 'attempting', 'uncertain'],
  uncertain: ['succeeded', 'failed'],
  succeeded: ['compensated'],
};

export const recordActionOutcome: Handler<{ actionId: string; status: 'attempting' | 'succeeded' | 'failed' | 'unknown' | 'uncertain' | 'cancelled' | 'compensated'; externalRef?: string; reconciled?: boolean; detail?: string }, { status: string }> = async (c, i) => {
  await c.authorize('action.record', { type: 'ExternalAction', id: i.actionId }, {});
  const a = (await c.q.query<{ status: string }>('SELECT status FROM external_actions WHERE id = $1 FOR UPDATE', [i.actionId])).rows[0];
  if (!a) throw new DomainError('not_found', 'Action not found');
  if (!(ALLOWED_NEXT[a.status] ?? []).includes(i.status)) throw new DomainError('guard_failed', `External action cannot go from ${a.status} to ${i.status}`);
  await c.q.query(`UPDATE external_actions SET status = $2, external_ref = COALESCE($3, external_ref), reconciled = $4, attempts = attempts + $5, updated_at = now(), version = version + 1 WHERE id = $1`,
    [i.actionId, i.status, i.externalRef ?? null, !!i.reconciled, i.status === 'attempting' ? 1 : 0]);
  c.emit({ type: 'action.outcome_recorded', aggregateType: 'external_action', aggregateId: i.actionId, payload: { from: a.status, to: i.status, external_ref: i.externalRef ?? null, reconciled: !!i.reconciled, detail: i.detail ?? null } });
  return { status: i.status };
};
