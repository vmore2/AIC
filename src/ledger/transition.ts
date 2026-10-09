// Applies a state-machine decision to a task row inside a command transaction.
import { decide, type GuardFacts, type TransitionType } from '../domain/stateMachine.js';
import type { TaskStatus } from '../domain/types.js';
import { DomainError, type CommandContext } from './engine.js';
import { getLease, getTask, type TaskRow } from './store.js';

export interface TransitionResult { task: TaskRow; from: TaskStatus; to: TaskStatus; epoch: number }

/**
 * Lock the task, evaluate guards (pure), apply effects, persist, and emit `task.status_changed`.
 * Callers must have already authorized the action via the PDP.
 */
export async function transitionTask(
  c: CommandContext, taskId: string, type: TransitionType, facts: Omit<GuardFacts, 'requesterType' | 'requesterId' | 'requesterEpoch'>,
  extra: { reason?: string; runId?: string; patch?: Record<string, unknown> } = {},
): Promise<TransitionResult> {
  const task = await getTask(c.q, taskId, true);
  const lease = await getLease(c.q, taskId, true);
  const epoch = lease?.epoch ?? 0;
  const d = decide(
    {
      status: task.status, kind: task.kind, riskTier: task.risk_tier, hold: task.hold, criteriaFrozen: !!task.criteria_frozen_at,
      attempt: task.attempt, maxAttempts: task.max_attempts, ownerId: task.owner_employee_id, managerId: task.manager_employee_id, leaseEpoch: epoch,
    },
    type,
    { ...facts, requesterType: c.principal.type, requesterId: c.principal.id, requesterEpoch: c.principal.epoch },
  );
  if (!d.ok) {
    const code = d.unmet.includes('lease_epoch_current') ? 'stale_lease' : 'guard_failed';
    throw new DomainError(code, `${type} not allowed for task ${taskId} in state ${task.status}: ${d.unmet.join(', ')}`, { unmet: d.unmet, current_state: task.status });
  }

  let newEpoch = epoch;
  let attempt = task.attempt;
  const sets: string[] = ['status = $2', 'status_changed_at = $3', 'version = version + 1'];
  const params: unknown[] = [taskId, d.to, c.now.toISOString()];
  const push = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };

  for (const eff of d.effects) {
    switch (eff) {
      case 'freeze_criteria':
        if (!task.criteria_set_id) throw new DomainError('guard_failed', 'No criteria set to freeze');
        await c.q.query(`UPDATE criteria_sets SET status='frozen', frozen_at=$2 WHERE id=$1 AND status='draft'`, [task.criteria_set_id, c.now.toISOString()]);
        push('criteria_frozen_at', c.now.toISOString());
        break;
      case 'grant_lease':
        newEpoch = epoch + 1;
        await c.q.query(
          `INSERT INTO task_leases (task_id, epoch, run_id, holder_employee_id, state, expires_at, renewed_at)
           VALUES ($1,$2,$3,$4,'active',$5,$6)
           ON CONFLICT (task_id) DO UPDATE SET epoch=$2, run_id=$3, holder_employee_id=$4, state='active', expires_at=$5, renewed_at=$6`,
          [taskId, newEpoch, extra.runId ?? null, task.owner_employee_id, new Date(c.now.getTime() + 120_000).toISOString(), c.now.toISOString()]);
        break;
      case 'suspend_lease':
        await c.q.query(`UPDATE task_leases SET state='suspended' WHERE task_id=$1`, [taskId]);
        break;
      case 'revoke_lease':
        if (lease && lease.state !== 'revoked' && lease.state !== 'released') {
          newEpoch = epoch + 1; // any later request from the old run is fenced off
          await c.q.query(`UPDATE task_leases SET state=$2, epoch=$3 WHERE task_id=$1`, [taskId, type === 'SubmitWork' ? 'released' : 'revoked', newEpoch]);
        }
        break;
      case 'increment_attempt':
        attempt += 1; push('attempt', attempt);
        break;
      case 'reset_attempts':
        attempt = 0; push('attempt', 0);
        break;
      case 'release_budget':
      case 'unblock_dependents':
      case 'mark_downstream_suspect':
        break; // handled by callers / orchestrator reactions
    }
  }
  for (const [k, v] of Object.entries(extra.patch ?? {})) push(k, v);
  await c.q.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, params);

  c.emit({
    type: 'task.status_changed', aggregateType: 'task', aggregateId: taskId,
    payload: { from: task.status, to: d.to, transition: type, reason: extra.reason ?? null, epoch: newEpoch, attempt, run_id: extra.runId ?? null, objective_id: task.objective_id, kind: task.kind },
  });
  return { task: { ...task, status: d.to, attempt }, from: task.status, to: d.to, epoch: newEpoch };
}
