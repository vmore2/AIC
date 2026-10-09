// Objectives, plans (team-lead proposals), task lifecycle, and human decisions.
import { hashOf, sha256Hex } from '../../domain/hash.js';
import { newId } from '../../domain/ids.js';
import { effectiveMode, humanAcceptanceRequired, modeAllowsExecution, planApprovalRequired } from '../../domain/modes.js';
import { maxRisk, type RiskTier, type TaskKind } from '../../domain/types.js';
import type { Department } from '../../org/schema.js';
import { DomainError, type CommandContext, type Handler } from '../engine.js';
import { validatePlan, type PlanValidation } from '../plan.js';
import { getEmployee, getLease, getObjective, getRun, getTask, modesFor, type TaskRow } from '../store.js';
import { transitionTask } from '../transition.js';

// ---------------------------------------------------------------- helpers

async function ownerContext(c: CommandContext, task: TaskRow, actionClass = 'A2') {
  const lease = await getLease(c.q, task.id);
  const epoch = lease?.epoch ?? 0;
  const mode = effectiveMode(...(await modesFor(c.q, task.objective_id)));
  const isOwner = c.principal.type === 'employee' && c.principal.id === task.owner_employee_id;
  return {
    mode, action_class: actionClass, is_owner: isOwner,
    epoch_current: c.principal.epoch !== undefined && c.principal.epoch === epoch && lease?.state === 'active',
    stale_epoch: c.principal.type === 'employee' && c.principal.epoch !== undefined && c.principal.epoch !== epoch,
    task_held: task.hold !== null,
  };
}

/** Does the employee principal currently hold a running run (managers acting from their own run)? */
async function managerRunActive(c: CommandContext): Promise<boolean> {
  if (c.principal.type !== 'employee' || !c.principal.runId) return false;
  const r = await c.q.query<{ status: string; employee_id: string }>('SELECT status, employee_id FROM runs WHERE id = $1', [c.principal.runId]);
  return r.rows[0]?.status === 'running' && r.rows[0].employee_id === c.principal.id;
}

async function departmentOf(c: CommandContext, departmentId: string): Promise<Department> {
  const r = await c.q.query<{ template: Department }>('SELECT template FROM departments WHERE id = $1', [departmentId]);
  if (!r.rows[0]) throw new DomainError('not_found', 'Department not found');
  return r.rows[0].template;
}

async function createCriteriaSet(c: CommandContext, taskId: string, criteria: { kind: string; statement: string; independence: string; required?: boolean; check?: unknown }[], frozen: boolean) {
  const id = newId('cs');
  const sha = hashOf(criteria);
  await c.q.query('INSERT INTO criteria_sets (id, task_id, version, status, frozen_at, content_sha256) VALUES ($1,$2,1,$3,$4,$5)',
    [id, taskId, 'draft', null, sha]);
  let n = 0;
  for (const cr of criteria) {
    await c.q.query('INSERT INTO criteria (id, criteria_set_id, ordinal, statement, kind, required, independence, check_spec) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [newId('ac'), id, n++, cr.statement, cr.kind, cr.required ?? true, cr.independence, cr.check ? JSON.stringify(cr.check) : null]);
  }
  if (frozen) await c.q.query(`UPDATE criteria_sets SET status='frozen', frozen_at=$2 WHERE id=$1`, [id, c.now.toISOString()]);
  await c.q.query('UPDATE tasks SET criteria_set_id = $2 WHERE id = $1', [taskId, id]);
  return id;
}

// ---------------------------------------------------------------- objectives

export interface CreateObjectiveInput {
  title: string;
  departmentKey: string;
  requirements: { key: string; text: string }[];
  budgetUsd: number;
  riskFloor?: RiskTier;
  deadline?: string;
  settings?: Record<string, string>;
}

export const createObjective: Handler<CreateObjectiveInput, { objectiveId: string; planningTaskId: string; planApprovalRequired: boolean }> = async (c, i) => {
  await c.authorize('objective.create', { type: 'Company', id: 'company' }, {});
  if (!i.requirements.length) throw new DomainError('validation', 'An objective needs at least one requirement');
  if (new Set(i.requirements.map((r) => r.key)).size !== i.requirements.length) throw new DomainError('validation', 'Requirement keys must be unique');
  if (!(i.budgetUsd > 0)) throw new DomainError('validation', 'Budget must be positive');
  const dep = (await c.q.query<{ id: string; template: Department; risk_floor: RiskTier }>('SELECT id, template, risk_floor FROM departments WHERE key = $1', [i.departmentKey])).rows[0];
  if (!dep) throw new DomainError('not_found', `Department "${i.departmentKey}" is not hired`);
  const head = (await c.q.query<{ id: string; tool_grants: string[]; role_snapshot: { budget: { per_run: { max_cost_usd: number } } } }>(
    `SELECT id, tool_grants, role_snapshot FROM employees WHERE department_id = $1 AND role_key = $2 AND status = 'active' ORDER BY created_at LIMIT 1`,
    [dep.id, dep.template.head])).rows[0];
  if (!head) throw new DomainError('not_found', 'Department head not found');
  const sponsor = (await c.q.query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [c.principal.id])).rows[0]?.id
    ?? (await c.q.query<{ id: string }>(`SELECT id FROM users WHERE role='ceo' LIMIT 1`)).rows[0]!.id;

  const objectiveId = newId('obj');
  const riskFloor = maxRisk(i.riskFloor ?? 'R0', dep.risk_floor);
  await c.q.query(`INSERT INTO objectives (id, title, department_id, owner_employee_id, sponsor_user_id, status, risk_floor, budget_limit, deadline, settings)
                   VALUES ($1,$2,$3,$4,$5,'planning',$6,$7,$8,$9)`,
    [objectiveId, i.title, dep.id, head.id, sponsor, riskFloor, i.budgetUsd, i.deadline ?? null, JSON.stringify(i.settings ?? {})]);
  const reqIds: string[] = [];
  for (const r of i.requirements) {
    const id = newId('req');
    reqIds.push(id);
    await c.q.query('INSERT INTO requirements (id, objective_id, key, current_version) VALUES ($1,$2,$3,1)', [id, objectiveId, r.key]);
    await c.q.query('INSERT INTO requirement_versions (requirement_id, version, text, text_sha256, authored_by) VALUES ($1,1,$2,$3,$4)',
      [id, r.text, sha256Hex(r.text), c.principal.id]);
  }

  const mode = effectiveMode(...(await modesFor(c.q, objectiveId)));
  const needsApproval = planApprovalRequired(mode, riskFloor);
  const planningTaskId = newId('tsk');
  const planBudget = Math.min(i.budgetUsd * 0.2, head.role_snapshot.budget.per_run.max_cost_usd * 3);
  await c.q.query(`INSERT INTO tasks (id, objective_id, depth, kind, title, spec, status, risk_tier, owner_employee_id, created_by_type, created_by,
                     max_attempts, budget_limit, tool_grants) VALUES ($1,$2,0,'planning',$3,$4,'draft',$5,$6,$7,$8,3,$9,$10)`,
    [planningTaskId, objectiveId, `Plan: ${i.title}`,
      'Propose a plan that satisfies every requirement of this objective: tasks with owners from your team, verifiable acceptance criteria, dependencies, budgets, risks, and open questions. Submit it with ledger.propose_plan.',
      riskFloor, head.id, c.principal.type, c.principal.id, planBudget, JSON.stringify(head.tool_grants)]);
  for (let k = 0; k < reqIds.length; k++)
    await c.q.query('INSERT INTO task_requirement_refs (task_id, requirement_id, requirement_version) VALUES ($1,$2,1)', [planningTaskId, reqIds[k]]);
  const criteria = [
    { kind: 'deterministic', statement: 'The plan passes structural validation and covers every requirement', independence: 'platform', check: { type: 'plan_validation' } },
    ...(needsApproval ? [{ kind: 'human_judgment', statement: 'The CEO approves the plan', independence: 'human' }] : []),
  ];
  await createCriteriaSet(c, planningTaskId, criteria, true);
  await c.q.query(`UPDATE tasks SET status='planned', criteria_frozen_at=$2 WHERE id=$1`, [planningTaskId, c.now.toISOString()]);

  c.emit({ type: 'objective.created', aggregateType: 'objective', aggregateId: objectiveId,
    payload: { title: i.title, department: i.departmentKey, requirements: i.requirements.map((r) => r.key), budget_usd: i.budgetUsd, risk_floor: riskFloor, mode } });
  c.emit({ type: 'task.created', aggregateType: 'task', aggregateId: planningTaskId,
    payload: { objective_id: objectiveId, kind: 'planning', owner: head.id, status: 'planned', plan_approval_required: needsApproval } });
  return { objectiveId, planningTaskId, planApprovalRequired: needsApproval };
};

// ---------------------------------------------------------------- dispatch & runs

export const markReady: Handler<{ taskId: string }, { status: string }> = async (c, i) => {
  await c.authorize('task.mark_ready', { type: 'Task', id: i.taskId }, {});
  const deps = await c.q.query<{ status: string; integrity: string }>(
    'SELECT t.status, t.integrity FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on_id WHERE d.task_id = $1', [i.taskId]);
  const depsSatisfied = deps.rows.every((d) => d.status === 'accepted' && d.integrity === 'ok');
  const r = await transitionTask(c, i.taskId, 'MarkReady', { depsSatisfied });
  return { status: r.to };
};

export const dispatchTask: Handler<{ taskId: string }, { runId: string; epoch: number; reservationUsd: number }> = async (c, i) => {
  await c.authorize('task.dispatch', { type: 'Task', id: i.taskId }, {});
  const task = await getTask(c.q, i.taskId, true);
  if (!task.owner_employee_id) throw new DomainError('guard_failed', 'Task has no owner');
  const emp = await getEmployee(c.q, task.owner_employee_id);
  const obj = await getObjective(c.q, task.objective_id, true);
  const mode = effectiveMode(...(await modesFor(c.q, task.objective_id)));
  const taskRemaining = Number(task.budget_limit) - Number(task.budget_spent);
  const objRemaining = Number(obj.budget_limit) - Number(obj.budget_reserved) - Number(obj.budget_spent);
  const reservation = Math.min(emp.role_snapshot.budget.per_run.max_cost_usd, taskRemaining, objRemaining);
  const runId = newId('run');
  const r = await transitionTask(c, i.taskId, 'Dispatch', {
    ownerActive: emp.status === 'active', budgetAvailable: reservation > 0, modeAllowsExecution: modeAllowsExecution(mode),
  }, { runId });
  await c.q.query(`INSERT INTO runs (id, task_id, attempt, lease_epoch, employee_id, mode, model_profile, model_family, status, budget_reserved)
                   VALUES ($1,$2,$3,$4,$5,'task',$6,$7,'running',$8)`,
    [runId, i.taskId, r.task.attempt, r.epoch, emp.id, emp.model_profile, emp.model_family, reservation]);
  await c.q.query('UPDATE objectives SET budget_reserved = budget_reserved + $2 WHERE id = $1', [obj.id, reservation]);
  c.emit({ type: 'run.started', aggregateType: 'run', aggregateId: runId,
    payload: { task_id: i.taskId, employee_id: emp.id, epoch: r.epoch, attempt: r.task.attempt, model_profile: emp.model_profile, reservation_usd: reservation } });
  return { runId, epoch: r.epoch, reservationUsd: reservation };
};

export const renewLease: Handler<{ taskId: string; runId: string }, { ok: boolean }> = async (c, i) => {
  await c.authorize('lease.renew', { type: 'Task', id: i.taskId }, {});
  const lease = await getLease(c.q, i.taskId, true);
  if (!lease || lease.run_id !== i.runId || lease.state !== 'active') return { ok: false };
  await c.q.query('UPDATE task_leases SET expires_at = $2, renewed_at = $3 WHERE task_id = $1', [i.taskId, new Date(c.now.getTime() + 120_000).toISOString(), c.now.toISOString()]);
  return { ok: true };
};

/** Model usage, metered by the Model Gateway before/after each call (INV-12). */
export const recordUsage: Handler<{ runId: string; inputTokens: number; outputTokens: number; costUsd: number; modelProfile: string }, { remainingUsd: number }> = async (c, i) => {
  await c.authorize('usage.record', { type: 'Run', id: i.runId }, {});
  const run = await getRun(c.q, i.runId);
  const reservedLeft = Math.max(0, Number(run.budget_reserved) - Number(run.cost_usd));
  await c.q.query('INSERT INTO usage_records (id, run_id, employee_id, model_profile, input_tokens, output_tokens, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [newId('use'), i.runId, run.employee_id, i.modelProfile, i.inputTokens, i.outputTokens, i.costUsd]);
  await c.q.query('UPDATE runs SET cost_usd = cost_usd + $2, input_tokens = input_tokens + $3, output_tokens = output_tokens + $4, steps = steps + 1 WHERE id = $1',
    [i.runId, i.costUsd, i.inputTokens, i.outputTokens]);
  if (run.task_id) {
    const t = await getTask(c.q, run.task_id);
    await c.q.query('UPDATE tasks SET budget_spent = budget_spent + $2 WHERE id = $1', [run.task_id, i.costUsd]);
    await c.q.query('UPDATE objectives SET budget_reserved = budget_reserved - $2, budget_spent = budget_spent + $3 WHERE id = $1',
      [t.objective_id, Math.min(reservedLeft, i.costUsd), i.costUsd]);
  }
  return { remainingUsd: Math.max(0, reservedLeft - i.costUsd) };
};

export type RunOutcome = 'failed' | 'abandoned' | 'ended_without_submission' | 'interrupted' | 'cancelled' | 'submitted' | 'completed' | 'suspended';

export const endRun: Handler<{ runId: string; outcome: RunOutcome; reason?: string }, { taskStatus: string | null }> = async (c, i) => {
  await c.authorize('run.end', { type: 'Run', id: i.runId }, {});
  const run = await getRun(c.q, i.runId);
  if (!['running', 'suspended'].includes(run.status) && !(run.status === 'submitted' && i.outcome === 'submitted')) return { taskStatus: null };
  const finalStatus = i.outcome === 'completed' ? 'completed' : i.outcome;
  const unusedReservation = Math.max(0, Number(run.budget_reserved) - Number(run.cost_usd));
  await c.q.query('UPDATE runs SET status = $2, failure_reason = $3, ended_at = $4 WHERE id = $1', [i.runId, finalStatus, i.reason ?? null, c.now.toISOString()]);
  let taskStatus: string | null = null;
  if (run.task_id && run.mode === 'task') {
    const task = await getTask(c.q, run.task_id);
    await c.q.query('UPDATE objectives SET budget_reserved = GREATEST(0, budget_reserved - $2) WHERE id = $1', [task.objective_id, unusedReservation]);
    const lease = await getLease(c.q, run.task_id);
    const current = lease && lease.run_id === run.id && lease.epoch === run.lease_epoch;
    // A suspended run (blocker raised) waits for the human/manager decision; no transition here.
    if (current && ['in_progress', 'awaiting_input'].includes(task.status) && i.outcome !== 'submitted' && i.outcome !== 'suspended') {
      const budgetExhausted = Number(task.budget_spent) >= Number(task.budget_limit) - 1e-9;
      const r = await transitionTask(c, run.task_id, i.outcome === 'abandoned' || i.outcome === 'interrupted' ? 'RecordRunAbandoned' : 'RecordRunFailed',
        { budgetExhausted }, { reason: `${i.outcome}${i.reason ? `: ${i.reason}` : ''}`, runId: run.id });
      taskStatus = r.to;
    }
  }
  c.emit({ type: 'run.ended', aggregateType: 'run', aggregateId: i.runId, payload: { task_id: run.task_id, outcome: i.outcome, reason: i.reason ?? null, mode: run.mode } });
  return { taskStatus };
};

// ---------------------------------------------------------------- employee commands (via Tool Gateway)

export interface ArtifactInput { kind: string; name: string; contentSha256: string; externalRef?: string; storagePath?: string }
export interface Claim { summary: string; per_criterion?: { criterion_id: string; self_assessment: 'met' | 'partially_met' | 'not_met'; notes?: string }[]; known_gaps?: string[] }

async function createSubmission(c: CommandContext, task: TaskRow, artifacts: ArtifactInput[], claim: Claim) {
  if (!c.principal.runId) throw new DomainError('validation', 'Submissions must come from a run');
  const lineage = [c.principal.id, c.principal.runId];
  const avIds: string[] = [];
  for (const a of artifacts) {
    let art = (await c.q.query<{ id: string }>('SELECT id FROM artifacts WHERE objective_id = $1 AND name = $2', [task.objective_id, a.name])).rows[0]?.id;
    if (!art) {
      art = newId('art');
      await c.q.query('INSERT INTO artifacts (id, objective_id, kind, name) VALUES ($1,$2,$3,$4)', [art, task.objective_id, a.kind, a.name]);
    }
    const av = newId('av');
    await c.q.query(`INSERT INTO artifact_versions (id, artifact_id, content_sha256, external_ref, storage_path, produced_by_run, produced_by_task, producer_lineage)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [av, art, a.contentSha256, a.externalRef ?? null, a.storagePath ?? null, c.principal.runId, task.id, JSON.stringify(lineage)]);
    await c.q.query(`INSERT INTO lineage_edges (from_type, from_id, rel, to_type, to_id) VALUES ('run',$1,'produced','artifact_version',$2) ON CONFLICT DO NOTHING`, [c.principal.runId, av]);
    avIds.push(av);
  }
  const subId = newId('sub');
  const sha = hashOf({ artifacts: artifacts.map((a) => a.contentSha256).sort(), criteria_set: task.criteria_set_id });
  await c.q.query(`UPDATE submissions SET status = 'superseded' WHERE task_id = $1 AND status = 'open'`, [task.id]);
  await c.q.query(`INSERT INTO submissions (id, task_id, run_id, criteria_set_id, claim, submission_sha256, status) VALUES ($1,$2,$3,$4,$5,$6,'open')`,
    [subId, task.id, c.principal.runId, task.criteria_set_id, JSON.stringify(claim), sha]);
  for (const av of avIds) await c.q.query('INSERT INTO submission_artifacts (submission_id, artifact_version_id) VALUES ($1,$2)', [subId, av]);
  await c.q.query(`UPDATE runs SET status = 'submitted', ended_at = $2 WHERE id = $1`, [c.principal.runId, c.now.toISOString()]);
  return { submissionId: subId, submissionSha: sha, artifactVersionIds: avIds };
}

export const submitWork: Handler<{ taskId: string; artifacts: ArtifactInput[]; claim: Claim }, { submissionId: string }> = async (c, i) => {
  const task = await getTask(c.q, i.taskId);
  await c.authorize('task.submit', { type: 'Task', id: i.taskId }, await ownerContext(c, task));
  if (task.kind === 'planning') throw new DomainError('validation', 'Planning tasks are submitted with ledger.propose_plan');
  if (!i.artifacts.length) throw new DomainError('guard_failed', 'At least one artifact is required');
  const open = await c.q.query(`SELECT 1 FROM external_actions WHERE task_id = $1 AND status IN ('intended','attempting')`, [i.taskId]);
  const sub = await createSubmission(c, task, i.artifacts, i.claim);
  await transitionTask(c, i.taskId, 'SubmitWork', { hasArtifacts: true, openAttemptingActions: open.rows.length }, { runId: c.principal.runId });
  c.emit({ type: 'submission.created', aggregateType: 'task', aggregateId: i.taskId,
    payload: { submission_id: sub.submissionId, submission_sha256: sub.submissionSha, artifact_versions: sub.artifactVersionIds, claim_summary: i.claim.summary } });
  return { submissionId: sub.submissionId };
};

export const proposePlan: Handler<{ taskId: string; plan: unknown }, { proposalId: string; validation: PlanValidation }> = async (c, i) => {
  const task = await getTask(c.q, i.taskId);
  await c.authorize('task.submit', { type: 'Task', id: i.taskId }, await ownerContext(c, task));
  if (task.kind !== 'planning') throw new DomainError('validation', 'Only planning tasks take plan proposals');
  const obj = await getObjective(c.q, task.objective_id);
  const dept = await departmentOf(c, obj.department_id);
  const emp = await getEmployee(c.q, c.principal.id);
  const reqs = await c.q.query<{ key: string }>(`SELECT key FROM requirements WHERE objective_id = $1 AND status = 'active' ORDER BY key`, [obj.id]);
  const validation = validatePlan(i.plan, {
    department: dept, leadRoleKey: emp.role_key, requirementKeys: reqs.rows.map((r) => r.key),
    budgetRemaining: Number(obj.budget_limit) - Number(obj.budget_spent) - Number(obj.budget_reserved) + Number(task.budget_limit) - Number(task.budget_spent),
    riskFloor: obj.risk_floor, settings: obj.settings,
  });
  if (!validation.ok) throw new DomainError('validation', `Plan rejected by validation: ${validation.errors.join('; ')}`, { errors: validation.errors });
  const proposalId = newId('prp');
  const contentSha = hashOf(i.plan);
  await c.q.query(`UPDATE proposals SET status = 'superseded' WHERE task_id = $1 AND status = 'submitted'`, [i.taskId]);
  await c.q.query(`INSERT INTO proposals (id, objective_id, task_id, author_employee_id, kind, status, content, content_sha256, validation)
                   VALUES ($1,$2,$3,$4,'plan','submitted',$5,$6,$7)`,
    [proposalId, obj.id, i.taskId, c.principal.id, JSON.stringify(i.plan), contentSha, JSON.stringify(validation)]);
  await createSubmission(c, task, [{ kind: 'plan', name: `plan:${obj.id}`, contentSha256: contentSha, externalRef: `proposal:${proposalId}` }],
    { summary: (i.plan as { summary?: string }).summary ?? 'Plan proposal' });
  await transitionTask(c, i.taskId, 'SubmitWork', { hasArtifacts: true, openAttemptingActions: 0 }, { runId: c.principal.runId });
  c.emit({ type: 'proposal.submitted', aggregateType: 'proposal', aggregateId: proposalId,
    payload: { objective_id: obj.id, task_id: i.taskId, tasks: validation.tasks.length, warnings: validation.warnings, content_sha256: contentSha } });
  return { proposalId, validation };
};

export interface EscalationInput { taskId: string; type: 'question' | 'decision_required' | 'blocker'; question: string; options?: { id: string; summary: string; consequences?: string }[]; recommendation?: string; blocking: boolean }

export const raiseEscalation: Handler<EscalationInput, { escalationId: string; blocking: boolean }> = async (c, i) => {
  const task = await getTask(c.q, i.taskId);
  await c.authorize(i.blocking ? 'task.raise_blocker' : 'task.ask_question', { type: 'Task', id: i.taskId }, await ownerContext(c, task));
  if (i.question.trim().length < 5) throw new DomainError('validation', 'Describe the question or blocker');
  const obj = await getObjective(c.q, task.objective_id);
  const toManager = i.type !== 'decision_required' && task.manager_employee_id && task.manager_employee_id !== c.principal.id;
  const routed = toManager ? { type: 'employee', id: task.manager_employee_id! } : { type: 'user', id: obj.sponsor_user_id };
  const dedup = sha256Hex(`${i.taskId}|${i.type}|${i.question.trim().toLowerCase()}`);
  const existing = (await c.q.query<{ id: string }>(`SELECT id FROM escalations WHERE dedup_key = $1 AND status = 'open'`, [dedup])).rows[0];
  const escalationId = existing?.id ?? newId('esc');
  if (!existing) {
    await c.q.query(`INSERT INTO escalations (id, task_id, raised_by_type, raised_by, type, body, dedup_key, routed_to_type, routed_to, status)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open')`,
      [escalationId, i.taskId, c.principal.type, c.principal.id, i.type, JSON.stringify({ question: i.question, options: i.options ?? [], recommendation: i.recommendation ?? null, blocking: i.blocking }), dedup, routed.type, routed.id]);
    c.emit({ type: 'escalation.raised', aggregateType: 'escalation', aggregateId: escalationId, payload: { task_id: i.taskId, type: i.type, routed_to: routed, blocking: i.blocking } });
  }
  if (i.blocking) await transitionTask(c, i.taskId, 'RaiseBlocker', {}, { reason: `escalation ${escalationId}`, runId: c.principal.runId });
  return { escalationId, blocking: i.blocking };
};

export const resolveEscalation: Handler<{ escalationId: string; answer: string; selectedOption?: string }, { decisionId: string; taskStatus: string | null }> = async (c, i) => {
  const e = (await c.q.query<{ id: string; task_id: string; status: string; body: { question: string }; routed_to: string }>('SELECT * FROM escalations WHERE id = $1 FOR UPDATE', [i.escalationId])).rows[0];
  if (!e) throw new DomainError('not_found', 'Escalation not found');
  if (e.status !== 'open') throw new DomainError('conflict', `Escalation is ${e.status}`);
  const task = await getTask(c.q, e.task_id);
  const managesTask = c.principal.type === 'employee' && task.manager_employee_id === c.principal.id;
  await c.authorize('escalation.resolve', { type: 'Task', id: e.task_id }, { manages_scope: managesTask, epoch_current: managesTask && (await managerRunActive(c)) });
  const decisionId = newId('dec');
  const basis = c.principal.type === 'user' ? `user:${c.principal.id}` : `manager_authority:${c.principal.id}`;
  await c.q.query(`INSERT INTO decisions (id, scope_type, scope_id, question, decision_text, decided_by_type, decided_by, authority_basis)
                   VALUES ($1,'objective',$2,$3,$4,$5,$6,$7)`,
    [decisionId, task.objective_id, e.body.question, i.selectedOption ? `Option ${i.selectedOption}: ${i.answer}` : i.answer, c.principal.type, c.principal.id, basis]);
  await c.q.query(`UPDATE escalations SET status = 'resolved', resolution_decision_id = $2, version = version + 1 WHERE id = $1`, [i.escalationId, decisionId]);
  c.emit({ type: 'decision.recorded', aggregateType: 'decision', aggregateId: decisionId, payload: { escalation_id: i.escalationId, task_id: e.task_id, decided_by: c.principal } });
  let taskStatus: string | null = null;
  if (task.status === 'awaiting_input') {
    const r = await transitionTask(c, task.id, 'ResolveBlocker', { requesterManagesTask: managesTask }, { reason: `resolved by decision ${decisionId}` });
    taskStatus = r.to;
  }
  return { decisionId, taskStatus };
};

export const postUpdate: Handler<{ taskId: string; text: string }, { ok: true }> = async (c, i) => {
  const task = await getTask(c.q, i.taskId);
  await c.authorize('task.post_update', { type: 'Task', id: i.taskId }, await ownerContext(c, task));
  c.emit({ type: 'task.update_posted', aggregateType: 'task', aggregateId: i.taskId, payload: { text: i.text.slice(0, 2000), note: 'claim, not status' } });
  return { ok: true };
};

// ---------------------------------------------------------------- human decisions

async function openSubmission(c: CommandContext, taskId: string) {
  const s = (await c.q.query<{ id: string; submission_sha256: string; run_id: string }>(`SELECT id, submission_sha256, run_id FROM submissions WHERE task_id = $1 AND status = 'open'`, [taskId])).rows[0];
  if (!s) throw new DomainError('guard_failed', 'Task has no open submission');
  return s;
}

async function producerLineage(c: CommandContext, submissionId: string): Promise<Set<string>> {
  const r = await c.q.query<{ producer_lineage: string[] }>(
    'SELECT av.producer_lineage FROM submission_artifacts sa JOIN artifact_versions av ON av.id = sa.artifact_version_id WHERE sa.submission_id = $1', [submissionId]);
  return new Set(r.rows.flatMap((x) => x.producer_lineage));
}

async function recordHumanEvidence(c: CommandContext, taskId: string, submissionId: string, result: 'pass' | 'fail', note: string) {
  const crit = await c.q.query<{ id: string }>(
    `SELECT cr.id FROM criteria cr JOIN submissions s ON s.criteria_set_id = cr.criteria_set_id WHERE s.id = $1 AND cr.independence = 'human'`, [submissionId]);
  const avs = (await c.q.query<{ artifact_version_id: string }>('SELECT artifact_version_id FROM submission_artifacts WHERE submission_id = $1', [submissionId])).rows;
  for (const cr of crit.rows) {
    const id = newId('evd');
    await c.q.query(`INSERT INTO evidence (id, task_id, submission_id, criterion_id, verifier_type, verifier_id, independence, result, definitive, details)
                     VALUES ($1,$2,$3,$4,'user',$5,'human',$6,true,$7)`, [id, taskId, submissionId, cr.id, c.principal.id, result, JSON.stringify({ note })]);
    for (const a of avs) await c.q.query('INSERT INTO evidence_artifacts (evidence_id, artifact_version_id) VALUES ($1,$2)', [id, a.artifact_version_id]);
    c.emit({ type: 'evidence.recorded', aggregateType: 'task', aggregateId: taskId, payload: { evidence_id: id, criterion_id: cr.id, result, independence: 'human', verifier: c.principal.id } });
  }
}

export const acceptTask: Handler<{ taskId: string; submissionSha256: string; rationale?: string; uncertain?: boolean }, { status: string }> = async (c, i) => {
  const task = await getTask(c.q, i.taskId);
  const sub = await openSubmission(c, i.taskId);
  const lineage = await producerLineage(c, sub.id);
  const inLineage = lineage.has(c.principal.id);
  await c.authorize(i.uncertain ? 'task.accept_uncertain' : 'task.accept', { type: 'Task', id: i.taskId }, { in_producer_lineage: inLineage });
  const bound = sub.submission_sha256 === i.submissionSha256;
  if (!bound) throw new DomainError('guard_failed', 'Acceptance is bound to a different submission (content changed since review)', { unmet: ['acceptance_bound_to_submission'] });
  await recordHumanEvidence(c, i.taskId, sub.id, 'pass', i.rationale ?? 'accepted');
  const approvalId = newId('apr');
  await c.q.query(`INSERT INTO approvals (id, subject_type, subject_id, subject_sha256, risk_tier, scope_text, status, decided_by, decided_at, rationale)
                   VALUES ($1,'task_acceptance',$2,$3,$4,$5,'approved',$6,$7,$8)`,
    [approvalId, i.taskId, sub.submission_sha256, task.risk_tier, `Accept ${task.title}`, c.principal.id, c.now.toISOString(), i.rationale ?? null]);
  const r = await transitionTask(c, i.taskId, i.uncertain ? 'AcceptUncertain' : 'AcceptTask',
    { approvalValid: bound, requesterInProducerLineage: inLineage, rationale: i.rationale }, { reason: i.rationale ?? 'accepted by human',
      patch: { accepted_submission_id: sub.id, assurance_label: i.uncertain ? 'A-qualified' : await humanLabel(c, sub.id) } });
  await c.q.query(`UPDATE submissions SET status = 'accepted' WHERE id = $1`, [sub.id]);
  return { status: r.to };
};

async function humanLabel(c: CommandContext, submissionId: string): Promise<string> {
  const r = await c.q.query<{ independence: string }>(`SELECT DISTINCT independence FROM evidence WHERE submission_id = $1 AND result = 'pass'`, [submissionId]);
  const s = new Set(r.rows.map((x) => x.independence));
  const det = s.has('platform_deterministic') || s.has('sandboxed_runner') || s.has('external_system');
  if (!det) return 'A-human-only';
  return `A-det${s.has('different_lineage_model') ? '+rev' : ''}+human`;
}

export const rejectTask: Handler<{ taskId: string; rationale: string }, { status: string }> = async (c, i) => {
  if (!i.rationale || i.rationale.trim().length < 3) throw new DomainError('validation', 'A rationale is required');
  const task = await getTask(c.q, i.taskId);
  await c.authorize('task.reject', { type: 'Task', id: i.taskId }, {});
  const sub = await openSubmission(c, i.taskId);
  await recordHumanEvidence(c, i.taskId, sub.id, 'fail', i.rationale);
  await c.q.query(`INSERT INTO approvals (id, subject_type, subject_id, subject_sha256, risk_tier, scope_text, status, decided_by, decided_at, rationale)
                   VALUES ($1,'task_acceptance',$2,$3,$4,$5,'rejected',$6,$7,$8)`,
    [newId('apr'), i.taskId, sub.submission_sha256, task.risk_tier, `Accept ${task.title}`, c.principal.id, c.now.toISOString(), i.rationale]);
  const r = await transitionTask(c, i.taskId, 'RejectTask', { rationale: i.rationale }, { reason: i.rationale });
  await c.q.query(`UPDATE submissions SET status = 'rejected' WHERE id = $1`, [sub.id]);
  return { status: r.to };
};

/** CEO decision on a team lead's plan proposal: approve (accept the planning task) or request changes. */
export const decideProposal: Handler<{ proposalId: string; decision: 'approve' | 'request_changes'; rationale?: string }, { status: string }> = async (c, i) => {
  const p = (await c.q.query<{ id: string; task_id: string; status: string; content_sha256: string }>('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [i.proposalId])).rows[0];
  if (!p) throw new DomainError('not_found', 'Proposal not found');
  if (p.status !== 'submitted') throw new DomainError('conflict', `Proposal is ${p.status}`);
  const sub = await openSubmission(c, p.task_id);
  let status: string;
  if (i.decision === 'approve') status = (await acceptTask(c, { taskId: p.task_id, submissionSha256: sub.submission_sha256, rationale: i.rationale })).status;
  else status = (await rejectTask(c, { taskId: p.task_id, rationale: i.rationale ?? '' })).status;
  await c.q.query('UPDATE proposals SET status = $2, version = version + 1 WHERE id = $1', [i.proposalId, i.decision === 'approve' ? 'approved' : 'changes_requested']);
  c.emit({ type: 'proposal.decided', aggregateType: 'proposal', aggregateId: i.proposalId, payload: { decision: i.decision, rationale: i.rationale ?? null } });
  return { status };
};

/** Turn an accepted plan into tasks (system reaction to an accepted planning task). */
export const materializePlan: Handler<{ planningTaskId: string }, { taskIds: string[] }> = async (c, i) => {
  await c.authorize('plan.materialize', { type: 'Task', id: i.planningTaskId }, {});
  const pt = await getTask(c.q, i.planningTaskId);
  if (pt.kind !== 'planning' || pt.status !== 'accepted') throw new DomainError('guard_failed', 'Planning task is not accepted');
  if ((await c.q.query('SELECT 1 FROM tasks WHERE parent_task_id = $1 LIMIT 1', [pt.id])).rows.length) return { taskIds: [] };
  const p = (await c.q.query<{ id: string; validation: PlanValidation }>(
    `SELECT p.id, p.validation FROM proposals p JOIN submissions s ON s.task_id = p.task_id
     WHERE p.task_id = $1 AND s.id = $2 AND p.status IN ('submitted','approved') ORDER BY p.created_at DESC LIMIT 1`, [pt.id, pt.accepted_submission_id])).rows[0];
  if (!p) throw new DomainError('not_found', 'No accepted proposal for planning task');
  await c.q.query(`UPDATE proposals SET status = 'approved' WHERE id = $1`, [p.id]);
  const obj = await getObjective(c.q, pt.objective_id);
  const reqs = new Map((await c.q.query<{ id: string; key: string; current_version: number }>('SELECT id, key, current_version FROM requirements WHERE objective_id = $1', [obj.id])).rows.map((r) => [r.key, r]));
  const refToId = new Map<string, string>();
  const load = new Map<string, number>();
  for (const t of p.validation.tasks) {
    const candidates = (await c.q.query<{ id: string }>(`SELECT id FROM employees WHERE department_id = $1 AND role_key = $2 AND status = 'active' ORDER BY created_at`, [obj.department_id, t.owner_role])).rows;
    if (!candidates.length) throw new DomainError('not_found', `No active employee for role ${t.owner_role}`);
    const owner = candidates.reduce((best, e) => ((load.get(e.id) ?? 0) < (load.get(best.id) ?? 0) ? e : best), candidates[0]!);
    load.set(owner.id, (load.get(owner.id) ?? 0) + 1);
    const id = newId('tsk');
    refToId.set(t.ref, id);
    await c.q.query(`INSERT INTO tasks (id, objective_id, parent_task_id, depth, kind, title, spec, status, risk_tier, owner_employee_id, manager_employee_id,
                       created_by_type, created_by, budget_limit, tool_grants, weight, proposal_id)
                     VALUES ($1,$2,$3,1,$4,$5,$6,'draft',$7,$8,$9,'system','plan',$10,$11,$12,$13)`,
      [id, obj.id, pt.id, t.kind as TaskKind, t.title, t.spec, t.risk_tier, owner.id, pt.owner_employee_id, t.budget_usd, JSON.stringify(t.tool_grants), t.weight, p.id]);
    for (const k of t.requirement_keys) {
      const r = reqs.get(k)!;
      await c.q.query('INSERT INTO task_requirement_refs (task_id, requirement_id, requirement_version) VALUES ($1,$2,$3)', [id, r.id, r.current_version]);
    }
    await createCriteriaSet(c, id, t.criteria, true);  // criteria approved as part of the plan → frozen
    await c.q.query(`UPDATE tasks SET status = 'planned', criteria_frozen_at = $2 WHERE id = $1`, [id, c.now.toISOString()]);
  }
  for (const t of p.validation.tasks) for (const d of t.depends_on)
    await c.q.query('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ($1,$2)', [refToId.get(t.ref), refToId.get(d)]);
  await c.q.query(`UPDATE objectives SET status = 'active', version = version + 1 WHERE id = $1`, [obj.id]);
  for (const [ref, id] of refToId) {
    const t = p.validation.tasks.find((x) => x.ref === ref)!;
    c.emit({ type: 'task.created', aggregateType: 'task', aggregateId: id, payload: { objective_id: obj.id, parent: pt.id, kind: t.kind, ref, status: 'planned', risk_tier: t.risk_tier } });
  }
  c.emit({ type: 'plan.materialized', aggregateType: 'objective', aggregateId: obj.id, payload: { planning_task_id: pt.id, proposal_id: p.id, tasks: refToId.size } });
  return { taskIds: [...refToId.values()] };
};

export const cancelTask: Handler<{ taskId: string; reason: string }, { status: string }> = async (c, i) => {
  const task = await getTask(c.q, i.taskId);
  const manages = c.principal.type === 'employee' && task.manager_employee_id === c.principal.id;
  await c.authorize('task.cancel', { type: 'Task', id: i.taskId }, { manages_scope: manages, epoch_current: manages && (await managerRunActive(c)) });
  const r = await transitionTask(c, i.taskId, 'CancelTask', { requesterManagesTask: manages }, { reason: i.reason });
  await c.q.query(`UPDATE runs SET status = 'cancelled', ended_at = $2 WHERE task_id = $1 AND status = 'running'`, [i.taskId, c.now.toISOString()]);
  return { status: r.to };
};

export const retryTask: Handler<{ taskId: string; addBudgetUsd: number; reason: string }, { status: string }> = async (c, i) => {
  await c.authorize('task.retry', { type: 'Task', id: i.taskId }, {});
  const task = await getTask(c.q, i.taskId);
  const obj = await getObjective(c.q, task.objective_id);
  const objRemaining = Number(obj.budget_limit) - Number(obj.budget_reserved) - Number(obj.budget_spent);
  if (i.addBudgetUsd > objRemaining) throw new DomainError('budget_exhausted', 'Objective budget cannot cover the retry');
  await c.q.query('UPDATE tasks SET budget_limit = budget_limit + $2 WHERE id = $1', [i.taskId, i.addBudgetUsd]);
  const r = await transitionTask(c, i.taskId, 'RetryTask', { budgetAvailable: i.addBudgetUsd > 0 }, { reason: i.reason });
  return { status: r.to };
};

export const reopenTask: Handler<{ taskId: string; reason: string }, { status: string; suspect: string[] }> = async (c, i) => {
  await c.authorize('task.reopen', { type: 'Task', id: i.taskId }, {});
  const r = await transitionTask(c, i.taskId, 'ReopenTask', { rationale: i.reason }, { reason: i.reason });
  // Downstream tasks that consumed this task's accepted output become suspect (§8.8).
  const down = await c.q.query<{ task_id: string }>(
    `SELECT d.task_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_id = $1 AND t.status = 'accepted'`, [i.taskId]);
  for (const d of down.rows) {
    await c.q.query(`UPDATE tasks SET integrity = 'suspect', version = version + 1 WHERE id = $1`, [d.task_id]);
    c.emit({ type: 'task.integrity_changed', aggregateType: 'task', aggregateId: d.task_id, payload: { integrity: 'suspect', cause: i.taskId } });
  }
  await c.q.query(`UPDATE tasks SET hold = 'dependency_regressed' WHERE id IN (SELECT task_id FROM task_dependencies WHERE depends_on_id = $1) AND status IN ('planned','ready')`, [i.taskId]);
  return { status: r.to, suspect: down.rows.map((d) => d.task_id) };
};


/** Tool-call audit records written by the Tool Gateway (tool_calls is a protected table, INV-1). */
export const recordToolCall: Handler<{ runId: string; tool: string; actionClass: string; argsSha256: string; decision: 'allow' | 'deny' | 'error'; reasons: string[]; epoch: number | null }, { seq: number }> = async (c, i) => {
  await c.authorize('toolcall.record', { type: 'Run', id: i.runId }, {});
  const seq = Number((await c.q.query<{ n: string }>('SELECT count(*) AS n FROM tool_calls WHERE run_id = $1', [i.runId])).rows[0]!.n) + 1;
  await c.q.query('INSERT INTO tool_calls (id, run_id, seq, tool, action_class, args_sha256, decision, reasons, lease_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [newId('tc'), i.runId, seq, i.tool, i.actionClass, i.argsSha256, i.decision, JSON.stringify(i.reasons), i.epoch]);
  if (i.decision !== 'allow') c.emit({ type: 'tool_call.denied', aggregateType: 'run', aggregateId: i.runId, payload: { tool: i.tool, decision: i.decision, reasons: i.reasons } });
  return { seq };
};

/** System: mark an objective complete once every planned task is accepted with intact integrity. */
export const completeObjective: Handler<{ objectiveId: string }, { completed: boolean; remaining: number }> = async (c, i) => {
  await c.authorize('objective.complete', { type: 'Objective', id: i.objectiveId }, {});
  const obj = await getObjective(c.q, i.objectiveId, true);
  if (obj.status !== 'active') return { completed: false, remaining: -1 };
  const r = await c.q.query<{ n: string }>(
    `SELECT count(*) AS n FROM tasks WHERE objective_id = $1 AND kind <> 'planning' AND status NOT IN ('cancelled','superseded')
       AND NOT (status = 'accepted' AND integrity = 'ok')`, [i.objectiveId]);
  const remaining = Number(r.rows[0]!.n);
  const total = Number((await c.q.query<{ n: string }>(`SELECT count(*) AS n FROM tasks WHERE objective_id = $1 AND kind <> 'planning'`, [i.objectiveId])).rows[0]!.n);
  if (remaining > 0 || total === 0) return { completed: false, remaining };
  await c.q.query(`UPDATE objectives SET status = 'completed', version = version + 1 WHERE id = $1`, [i.objectiveId]);
  c.emit({ type: 'objective.completed', aggregateType: 'objective', aggregateId: i.objectiveId, payload: { tasks: total, note: 'All planned work accepted. Release to the main branch requires CEO approval.' } });
  return { completed: true, remaining: 0 };
};

/** CEO approves releasing an objective's integrated work to the protected base branch (A5). */
export const approveRelease: Handler<{ objectiveId: string; integrationSha: string; rationale?: string }, { approvalId: string }> = async (c, i) => {
  await c.authorize('approval.decide', { type: 'Objective', id: i.objectiveId }, { action_class: 'A5' });
  const obj = await getObjective(c.q, i.objectiveId);
  if (obj.status !== 'completed') throw new DomainError('guard_failed', 'Only completed objectives can be released');
  if (!/^[0-9a-f]{7,64}$/.test(i.integrationSha)) throw new DomainError('validation', 'integrationSha must be the reviewed commit');
  const approvalId = newId('apr');
  await c.q.query(`INSERT INTO approvals (id, subject_type, subject_id, subject_sha256, risk_tier, scope_text, status, decided_by, decided_at, rationale, expires_at)
                   VALUES ($1,'external_action',$2,$3,$4,$5,'approved',$6,$7,$8,$9)`,
    [approvalId, i.objectiveId, i.integrationSha, obj.risk_floor, `Merge integration ${i.integrationSha.slice(0, 12)} into the base branch`, c.principal.id, c.now.toISOString(), i.rationale ?? null,
      new Date(c.now.getTime() + 24 * 3600_000).toISOString()]);
  c.emit({ type: 'release.approved', aggregateType: 'objective', aggregateId: i.objectiveId, payload: { approval_id: approvalId, integration_sha: i.integrationSha } });
  return { approvalId };
};
