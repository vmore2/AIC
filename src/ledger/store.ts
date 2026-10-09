// Typed row access for the ledger. Writes happen only inside Transition Engine handlers.
import type { Queryable } from './db.js';
import { DomainError } from './engine.js';
import type { Hold, Mode, RiskTier, TaskKind, TaskStatus } from '../domain/types.js';
import type { Role } from '../org/schema.js';
import type { Check } from '../org/schema.js';

export interface TaskRow {
  id: string; objective_id: string; parent_task_id: string | null; depth: number; kind: TaskKind; title: string; spec: string;
  status: TaskStatus; hold: Hold | null; integrity: 'ok' | 'suspect'; risk_tier: RiskTier;
  owner_employee_id: string | null; manager_employee_id: string | null; created_by_type: string; created_by: string;
  criteria_set_id: string | null; criteria_frozen_at: string | null; attempt: number; max_attempts: number;
  weight: string; budget_limit: string; budget_spent: string; tool_grants: string[]; autonomy_ceiling: Mode;
  proposal_id: string | null; accepted_submission_id: string | null; assurance_label: string | null; version: number;
  status_changed_at: string; created_at: string;
}
export interface EmployeeRow {
  id: string; display_name: string; department_id: string; role_key: string; role_version: number; role_snapshot: Role;
  category: string; can_manage: boolean; manager_employee_id: string | null; reports_to_user_id: string | null;
  model_profile: string; model_family: string; tool_grants: string[]; status: string; version: number;
}
export interface ObjectiveRow {
  id: string; title: string; department_id: string; owner_employee_id: string; sponsor_user_id: string; status: string;
  risk_floor: RiskTier; budget_limit: string; budget_reserved: string; budget_spent: string; deadline: string | null;
  settings: Record<string, string>; version: number;
}
export interface CriterionRow {
  id: string; criteria_set_id: string; ordinal: number; statement: string; kind: string; required: boolean;
  independence: 'platform' | 'different_lineage_model' | 'human' | 'external_system'; check_spec: Check | null;
}
export interface LeaseRow { task_id: string; epoch: number; run_id: string | null; holder_employee_id: string | null; state: string; expires_at: string | null }
export interface RunRow {
  id: string; task_id: string | null; attempt: number; lease_epoch: number; employee_id: string; mode: 'task' | 'review' | 'conversation';
  model_profile: string; model_family: string; status: string; failure_reason: string | null; steps: number; cost_usd: string; budget_reserved: string;
  workspace_path: string | null; branch: string | null; transcript_path: string | null; review_of_submission_id: string | null; conversation_id: string | null;
  started_at: string; ended_at: string | null;
}

export async function one<T>(q: Queryable, sql: string, params: unknown[], what: string): Promise<T> {
  const r = await q.query<T>(sql, params);
  if (!r.rows[0]) throw new DomainError('not_found', `${what} not found`);
  return r.rows[0];
}

export const getTask = (q: Queryable, id: string, lock = false) =>
  one<TaskRow>(q, `SELECT * FROM tasks WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id], `Task ${id}`).then(normTask);
export const getEmployee = (q: Queryable, id: string) => one<EmployeeRow>(q, 'SELECT * FROM employees WHERE id = $1', [id], `Employee ${id}`);
export const getObjective = (q: Queryable, id: string, lock = false) =>
  one<ObjectiveRow>(q, `SELECT * FROM objectives WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id], `Objective ${id}`);
export const getRun = (q: Queryable, id: string) => one<RunRow>(q, 'SELECT * FROM runs WHERE id = $1', [id], `Run ${id}`).then(normRun);

export async function getLease(q: Queryable, taskId: string, lock = false): Promise<LeaseRow | null> {
  const r = await q.query<LeaseRow>(`SELECT * FROM task_leases WHERE task_id = $1${lock ? ' FOR UPDATE' : ''}`, [taskId]);
  return r.rows[0] ? { ...r.rows[0], epoch: Number(r.rows[0].epoch) } : null;
}

export async function getCriteria(q: Queryable, criteriaSetId: string): Promise<CriterionRow[]> {
  return (await q.query<CriterionRow>('SELECT * FROM criteria WHERE criteria_set_id = $1 ORDER BY ordinal', [criteriaSetId])).rows;
}

const normTask = (t: TaskRow): TaskRow => ({ ...t, attempt: Number(t.attempt), max_attempts: Number(t.max_attempts), depth: Number(t.depth), version: Number(t.version) });
const normRun = (r: RunRow): RunRow => ({ ...r, attempt: Number(r.attempt), lease_epoch: Number(r.lease_epoch), steps: Number(r.steps) });

/** Effective mode for a task: the most restrictive of company, department, and objective settings. */
export async function modesFor(q: Queryable, objectiveId: string): Promise<(Mode | undefined)[]> {
  const o = await getObjective(q, objectiveId);
  const r = await q.query<{ scope_type: string; scope_id: string; mode: Mode }>(
    `SELECT scope_type, scope_id, mode FROM mode_settings WHERE (scope_type='company') OR (scope_type='department' AND scope_id=$1) OR (scope_type='objective' AND scope_id=$2)`,
    [o.department_id, objectiveId]);
  return r.rows.map((x) => x.mode);
}

/** All employees in the management chain above an employee (for authority checks). */
export async function managementChain(q: Queryable, employeeId: string): Promise<string[]> {
  const chain: string[] = [];
  let cur: string | null = employeeId;
  for (let i = 0; i < 10 && cur; i++) {
    const r: { rows: { manager_employee_id: string | null }[] } = await q.query('SELECT manager_employee_id FROM employees WHERE id = $1', [cur]);
    cur = r.rows[0]?.manager_employee_id ?? null;
    if (cur) chain.push(cur);
  }
  return chain;
}
