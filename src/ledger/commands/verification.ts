// Verification: evidence recording and deterministic completion evaluation (§8.5, §11).
import { assuranceLabel, evaluateCompletion, type EvidenceRecord } from '../../domain/completion.js';
import { newId } from '../../domain/ids.js';
import { humanAcceptanceRequired } from '../../domain/modes.js';
import type { IndependenceClass } from '../../domain/types.js';
import { DomainError, type CommandContext, type Handler } from '../engine.js';
import { getCriteria, getObjective, getRun, getTask } from '../store.js';
import type { Role } from '../../org/schema.js';
import { transitionTask } from '../transition.js';

export const startVerification: Handler<{ taskId: string }, { status: string }> = async (c, i) => {
  await c.authorize('task.start_verification', { type: 'Task', id: i.taskId }, {});
  const r = await transitionTask(c, i.taskId, 'StartVerification', {});
  return { status: r.to };
};

export interface EvidenceInput {
  submissionId: string;
  criterionId: string;
  result: 'pass' | 'fail' | 'inconclusive' | 'error';
  definitive?: boolean;
  confidence?: number;
  details: Record<string, unknown>;
  /** Service verifiers (system principal) declare their identity and class; employees and users are classified by the engine. */
  service?: { id: string; independence: Extract<IndependenceClass, 'platform_deterministic' | 'sandboxed_runner' | 'external_system'>; config?: Record<string, unknown> };
}

export const recordEvidence: Handler<EvidenceInput, { evidenceId: string; independence: IndependenceClass }> = async (c, i) => {
  const sub = (await c.q.query<{ id: string; task_id: string; status: string; criteria_set_id: string }>('SELECT * FROM submissions WHERE id = $1', [i.submissionId])).rows[0];
  if (!sub) throw new DomainError('not_found', 'Submission not found');
  if (sub.status !== 'open') throw new DomainError('guard_failed', `Submission is ${sub.status}; evidence must target the open submission`);
  const crit = (await c.q.query<{ id: string }>('SELECT id FROM criteria WHERE id = $1 AND criteria_set_id = $2', [i.criterionId, sub.criteria_set_id])).rows[0];
  if (!crit) throw new DomainError('validation', 'Criterion does not belong to this submission\'s criteria set');
  const task = await getTask(c.q, sub.task_id);
  if (!['verifying', 'in_review'].includes(task.status)) throw new DomainError('guard_failed', `Task is ${task.status}; not accepting evidence`);

  const lineageRows = await c.q.query<{ producer_lineage: string[] }>(
    'SELECT av.producer_lineage FROM submission_artifacts sa JOIN artifact_versions av ON av.id = sa.artifact_version_id WHERE sa.submission_id = $1', [sub.id]);
  const lineage = new Set(lineageRows.rows.flatMap((r) => r.producer_lineage));

  let verifierType: string; let verifierId: string; let independence: IndependenceClass; let familyDiffers: boolean | null = null; let config: Record<string, unknown> = {};
  if (c.principal.type === 'system') {
    if (!i.service) throw new DomainError('validation', 'Service verifiers must declare their identity');
    await c.authorize('evidence.record', { type: 'Task', id: task.id }, {});
    verifierType = 'service'; verifierId = i.service.id; independence = i.service.independence; config = i.service.config ?? {};
  } else if (c.principal.type === 'employee') {
    // Only an assigned, running review run may record model-review evidence.
    const run = c.principal.runId ? await getRun(c.q, c.principal.runId) : null;
    const assigned = !!run && run.mode === 'review' && run.review_of_submission_id === sub.id && run.employee_id === c.principal.id && run.status === 'running';
    await c.authorize('review.record_verdict', { type: 'Task', id: task.id }, { is_assigned_reviewer: assigned, epoch_current: assigned });
    verifierType = 'employee'; verifierId = c.principal.id;
    if (lineage.has(c.principal.id)) independence = 'same_lineage_model';
    else {
      independence = 'different_lineage_model';
      const fams = await c.q.query<{ model_family: string }>(`SELECT DISTINCT model_family FROM employees WHERE id = ANY($1::text[])`, [[...lineage]]);
      const runFams = await c.q.query<{ model_family: string }>(`SELECT DISTINCT model_family FROM runs WHERE id = ANY($1::text[])`, [[...lineage]]);
      const producerFamilies = new Set([...fams.rows, ...runFams.rows].map((r) => r.model_family));
      familyDiffers = !producerFamilies.has(run!.model_family);
    }
    config = { run_id: run!.id, model_profile: run!.model_profile, model_family: run!.model_family };
  } else {
    await c.authorize('evidence.record_human', { type: 'Task', id: task.id }, { in_producer_lineage: lineage.has(c.principal.id) });
    verifierType = 'user'; verifierId = c.principal.id; independence = 'human';
  }

  const id = newId('evd');
  await c.q.query(`INSERT INTO evidence (id, task_id, submission_id, criterion_id, verifier_type, verifier_id, verifier_config, independence, family_differs, result, definitive, confidence, details)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, task.id, sub.id, i.criterionId, verifierType, verifierId, JSON.stringify(config), independence, familyDiffers, i.result, i.definitive ?? true, i.confidence ?? null, JSON.stringify(i.details)]);
  const avs = await c.q.query<{ artifact_version_id: string }>('SELECT artifact_version_id FROM submission_artifacts WHERE submission_id = $1', [sub.id]);
  for (const a of avs.rows) await c.q.query('INSERT INTO evidence_artifacts (evidence_id, artifact_version_id) VALUES ($1,$2)', [id, a.artifact_version_id]);
  c.emit({ type: 'evidence.recorded', aggregateType: 'task', aggregateId: task.id,
    payload: { evidence_id: id, submission_id: sub.id, criterion_id: i.criterionId, result: i.result, independence, verifier: verifierId, family_differs: familyDiffers } });
  return { evidenceId: id, independence };
};

export async function loadEvaluationInput(c: Pick<CommandContext, 'q'>, taskId: string) {
  const task = await getTask(c.q, taskId);
  const sub = (await c.q.query<{ id: string; criteria_set_id: string }>(`SELECT id, criteria_set_id FROM submissions WHERE task_id = $1 AND status = 'open'`, [taskId])).rows[0];
  if (!sub) throw new DomainError('guard_failed', 'No open submission to evaluate');
  const criteria = await getCriteria(c.q, sub.criteria_set_id);
  const avs = (await c.q.query<{ artifact_version_id: string; producer_lineage: string[] }>(
    'SELECT sa.artifact_version_id, av.producer_lineage FROM submission_artifacts sa JOIN artifact_versions av ON av.id = sa.artifact_version_id WHERE sa.submission_id = $1', [sub.id])).rows;
  const ev = (await c.q.query<{ id: string; criterion_id: string; verifier_id: string; independence: IndependenceClass; family_differs: boolean | null; result: EvidenceRecord['result']; definitive: boolean }>(
    'SELECT * FROM evidence WHERE submission_id = $1', [sub.id])).rows;
  const evArts = (await c.q.query<{ evidence_id: string; artifact_version_id: string }>(
    'SELECT ea.* FROM evidence_artifacts ea JOIN evidence e ON e.id = ea.evidence_id WHERE e.submission_id = $1', [sub.id])).rows;
  const actions = (await c.q.query<{ id: string; status: string; required_for_acceptance: boolean }>('SELECT id, status, required_for_acceptance FROM external_actions WHERE task_id = $1', [taskId])).rows;
  return {
    task, submissionId: sub.id,
    input: {
      criteria: criteria.map((cr) => ({ id: cr.id, statement: cr.statement, kind: cr.kind as never, required: cr.required, independence: cr.independence })),
      evidence: ev.map((e) => ({ id: e.id, criterionId: e.criterion_id, verifierId: e.verifier_id, independence: e.independence, familyDiffers: e.family_differs ?? undefined,
        result: e.result, definitive: e.definitive, artifactVersionIds: evArts.filter((a) => a.evidence_id === e.id).map((a) => a.artifact_version_id) })),
      submittedArtifactVersionIds: avs.map((a) => a.artifact_version_id),
      producerLineage: new Set(avs.flatMap((a) => a.producer_lineage)),
      riskTier: task.risk_tier,
      actions: actions.map((a) => ({ id: a.id, status: a.status, requiredForAcceptance: a.required_for_acceptance })),
    },
  };
}

/** Run the deterministic Completion Evaluator and apply its outcome (no LLM involved). */
export const evaluateTask: Handler<{ taskId: string }, { outcome: string; status: string }> = async (c, i) => {
  await c.authorize('task.evaluate', { type: 'Task', id: i.taskId }, {});
  const { task, submissionId, input } = await loadEvaluationInput(c, i.taskId);
  if (!['verifying', 'in_review'].includes(task.status)) return { outcome: 'not_applicable', status: task.status };
  const result = evaluateCompletion(input);
  c.emit({ type: 'evaluation.completed', aggregateType: 'task', aggregateId: i.taskId,
    payload: { submission_id: submissionId, outcome: result.outcome, criteria: result.criteria.map((x) => ({ id: x.id, status: x.status, excluded: x.excludedEvidence })) } });
  if (result.outcome === 'pending') return { outcome: 'pending', status: task.status };
  if (result.outcome === 'awaiting_review' && task.status === 'in_review') return { outcome: result.outcome, status: task.status };
  const needsHuman = humanAcceptanceRequired(task.risk_tier);
  const label = assuranceLabel(input, result);
  const r = await transitionTask(c, i.taskId, 'ApplyEvaluation', { evaluation: result.outcome, humanAcceptanceRequired: needsHuman },
    { reason: `evaluation: ${result.outcome}`, patch: result.outcome === 'satisfied' && !needsHuman ? { accepted_submission_id: submissionId, assurance_label: label } : {} });
  if (r.to === 'accepted') await c.q.query(`UPDATE submissions SET status = 'accepted' WHERE id = $1`, [submissionId]);
  return { outcome: result.outcome, status: r.to };
};

export const requeueAfterChanges: Handler<{ taskId: string }, { status: string }> = async (c, i) => {
  await c.authorize('task.requeue', { type: 'Task', id: i.taskId }, {});
  await c.q.query(`UPDATE submissions SET status = 'rejected' WHERE task_id = $1 AND status = 'open'`, [i.taskId]);
  const r = await transitionTask(c, i.taskId, 'RequeueAfterChanges', {}, { reason: 'verification requested changes' });
  return { status: r.to };
};

/** Start an independent review run for a submission (assigned by the platform, never by the producer). */
export const MAX_REVIEW_RUNS = 2;

/**
 * Returns `runId: null` when no review can run (repeated reviewer failures or no objective budget left);
 * the task then goes to a human as UNCERTAIN instead of waiting forever for a verdict.
 */
export const assignReview: Handler<{ taskId: string; reviewerEmployeeId: string }, { runId: string | null; submissionId: string; unavailable?: string }> = async (c, i) => {
  await c.authorize('review.assign', { type: 'Task', id: i.taskId }, {});
  const sub = (await c.q.query<{ id: string }>(`SELECT id FROM submissions WHERE task_id = $1 AND status = 'open'`, [i.taskId])).rows[0];
  if (!sub) throw new DomainError('guard_failed', 'No open submission');
  const lineage = new Set((await c.q.query<{ producer_lineage: string[] }>(
    'SELECT av.producer_lineage FROM submission_artifacts sa JOIN artifact_versions av ON av.id = sa.artifact_version_id WHERE sa.submission_id = $1', [sub.id])).rows.flatMap((r) => r.producer_lineage));
  if (lineage.has(i.reviewerEmployeeId)) throw new DomainError('guard_failed', 'Reviewer is in the producer lineage (INV-2)');
  const emp = (await c.q.query<{ id: string; model_profile: string; model_family: string; category: string; status: string; role_snapshot: Role }>('SELECT * FROM employees WHERE id = $1', [i.reviewerEmployeeId])).rows[0];
  if (!emp || emp.status !== 'active') throw new DomainError('not_found', 'Reviewer not available');
  if (emp.category !== 'reviewer' && emp.category !== 'qa') throw new DomainError('guard_failed', 'Assigned employee is not a reviewer');
  const existing = (await c.q.query<{ id: string }>(`SELECT id FROM runs WHERE review_of_submission_id = $1 AND status = 'running'`, [sub.id])).rows[0];
  if (existing) return { runId: existing.id, submissionId: sub.id };
  const task = await getTask(c.q, i.taskId, true);
  const obj = await getObjective(c.q, task.objective_id, true);
  const failed = Number((await c.q.query<{ n: string }>(`SELECT count(*) AS n FROM runs WHERE review_of_submission_id = $1 AND status <> 'running'`, [sub.id])).rows[0]!.n);
  const objRemaining = Number(obj.budget_limit) - Number(obj.budget_reserved) - Number(obj.budget_spent);
  const reservation = Math.min(emp.role_snapshot.budget.per_run.max_cost_usd, objRemaining);
  const unavailable = failed >= MAX_REVIEW_RUNS ? `the independent review failed ${failed} times` : reservation <= 0 ? 'the objective budget is exhausted' : null;
  if (unavailable) {
    await transitionTask(c, i.taskId, 'ApplyEvaluation', { evaluation: 'uncertain', humanAcceptanceRequired: true }, { reason: `review unavailable: ${unavailable}` });
    c.emit({ type: 'review.unavailable', aggregateType: 'task', aggregateId: i.taskId, payload: { submission_id: sub.id, reason: unavailable } });
    return { runId: null, submissionId: sub.id, unavailable };
  }
  const runId = newId('run');
  await c.q.query(`INSERT INTO runs (id, task_id, employee_id, mode, model_profile, model_family, status, review_of_submission_id, budget_reserved)
                   VALUES ($1,$2,$3,'review',$4,$5,'running',$6,$7)`, [runId, i.taskId, emp.id, emp.model_profile, emp.model_family, sub.id, reservation]);
  await c.q.query('UPDATE objectives SET budget_reserved = budget_reserved + $2 WHERE id = $1', [obj.id, reservation]);
  c.emit({ type: 'review.assigned', aggregateType: 'task', aggregateId: i.taskId, payload: { run_id: runId, reviewer: emp.id, submission_id: sub.id } });
  return { runId, submissionId: sub.id };
};
