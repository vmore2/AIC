// Context Assembler (architecture.md §9.5.2, §9.6, §10.6).
// Employees are stateless: every run is reconstructed from the ledger. Requirements and criteria
// are injected VERBATIM (INV-17); advisory content is labeled as such. Memory never grants authority.
import type { Queryable } from '../ledger/db.js';
import { getCriteria, getEmployee, getObjective, getTask } from '../ledger/store.js';
import type { Department } from '../org/schema.js';

export interface TaskContract {
  task: { id: string; kind: string; title: string; spec: string; risk_tier: string; attempt: number; max_attempts: number };
  objective: { id: string; title: string };
  requirements: { key: string; version: number; text: string }[];
  acceptance_criteria: { id: string; statement: string; kind: string; required: boolean; verified_by: string; check?: unknown }[];
  constraints: { id: string; text: string; decided_by: string }[];
  prior_attempt_feedback: string[];
  budget: { task_limit_usd: number; task_spent_usd: number };
  permissions: string[];
  how_to_finish: string;
  planning?: PlanningBrief;
}

export interface PlanningBrief {
  requirement_keys: string[];
  budget_available_usd: number;
  your_team: { role: string; title: string; category: string; task_kinds: string[]; default_criteria: string[]; headcount: number }[];
  settings: Record<string, string>;
  plan_format: unknown;
}

export async function buildTaskContract(q: Queryable, taskId: string, employeeId: string): Promise<TaskContract> {
  const task = await getTask(q, taskId);
  const obj = await getObjective(q, task.objective_id);
  const reqs = await q.query<{ key: string; version: number; text: string }>(
    `SELECT r.key, rv.version, rv.text FROM task_requirement_refs tr JOIN requirements r ON r.id = tr.requirement_id
     JOIN requirement_versions rv ON rv.requirement_id = tr.requirement_id AND rv.version = tr.requirement_version
     WHERE tr.task_id = $1 ORDER BY r.key`, [taskId]);
  const criteria = task.criteria_set_id ? await getCriteria(q, task.criteria_set_id) : [];
  const decisions = await q.query<{ id: string; question: string; decision_text: string; decided_by: string }>(
    `SELECT id, question, decision_text, decided_by FROM decisions WHERE scope_type = 'objective' AND scope_id = $1 ORDER BY created_at`, [obj.id]);
  const feedback: string[] = [];
  const failed = await q.query<{ statement: string; result: string; details: { note?: string; summary?: string; findings?: unknown } }>(
    `SELECT cr.statement, e.result, e.details FROM evidence e JOIN criteria cr ON cr.id = e.criterion_id JOIN submissions s ON s.id = e.submission_id
     WHERE e.task_id = $1 AND s.status IN ('rejected','superseded') AND e.result <> 'pass' ORDER BY e.created_at`, [taskId]);
  for (const f of failed.rows) feedback.push(`Criterion "${f.statement}" — ${f.result}: ${JSON.stringify(f.details).slice(0, 1200)}`);
  const rejected = await q.query<{ rationale: string }>(`SELECT rationale FROM approvals WHERE subject_id = $1 AND status = 'rejected' ORDER BY created_at`, [taskId]);
  for (const r of rejected.rows) feedback.push(`Human reviewer requested changes: ${r.rationale}`);
  const reopens = await q.query<{ reason: string | null }>(
    `SELECT payload->>'reason' AS reason FROM ledger_events WHERE aggregate_id = $1 AND type = 'task.status_changed' AND payload->>'transition' = 'ReopenTask' ORDER BY seq`, [taskId]);
  for (const r of reopens.rows) feedback.push(`This task was reopened after acceptance: ${r.reason ?? 'no reason recorded'}`);
  const emp = await getEmployee(q, employeeId);

  const contract: TaskContract = {
    task: { id: task.id, kind: task.kind, title: task.title, spec: task.spec, risk_tier: task.risk_tier, attempt: task.attempt, max_attempts: task.max_attempts },
    objective: { id: obj.id, title: obj.title },
    requirements: reqs.rows,
    acceptance_criteria: criteria.map((c) => ({ id: c.id, statement: c.statement, kind: c.kind, required: c.required, verified_by: c.independence, ...(c.check_spec ? { check: c.check_spec } : {}) })),
    constraints: decisions.rows.map((d) => ({ id: d.id, text: `${d.question} → ${d.decision_text}`, decided_by: d.decided_by })),
    prior_attempt_feedback: feedback,
    budget: { task_limit_usd: Number(task.budget_limit), task_spent_usd: Number(task.budget_spent) },
    permissions: (task.tool_grants as string[]).filter((t) => emp.tool_grants.includes(t)),
    how_to_finish: task.kind === 'planning'
      ? 'Call ledger.propose_plan with a complete plan. If it fails validation, fix the listed errors and call it again. The CEO decides; you cannot approve your own plan.'
      : 'Write your deliverable files in the workspace, run any checks, then call ledger.submit_work. Your claim does not complete the task — independent verification against the acceptance criteria decides.',
  };

  if (task.kind === 'planning') {
    const dept = (await q.query<{ template: Department }>('SELECT template FROM departments WHERE id = $1', [obj.department_id])).rows[0]!.template;
    const lead = emp.role_key;
    const team = dept.structure.filter((s) => s.reports_to === lead || s.role === lead || dept.roles.find((r) => r.key === s.role)?.category === 'qa');
    const allReqs = await q.query<{ key: string }>(`SELECT key FROM requirements WHERE objective_id = $1 AND status = 'active' ORDER BY key`, [obj.id]);
    contract.planning = {
      requirement_keys: allReqs.rows.map((r) => r.key),
      budget_available_usd: Number(obj.budget_limit) - Number(obj.budget_spent) - Number(obj.budget_reserved) + Number(task.budget_limit) - Number(task.budget_spent),
      your_team: team.map((s) => {
        const r = dept.roles.find((x) => x.key === s.role)!;
        return { role: r.key, title: r.title, category: r.category, task_kinds: r.task_kinds, default_criteria: r.criteria_templates.map((c) => c.statement), headcount: s.count };
      }),
      settings: obj.settings,
      plan_format: {
        summary: 'string', risks: ['string'], open_questions: ['string'],
        tasks: [{ ref: 'short-id', title: 'string', kind: 'implementation', spec: 'what to do, specifically', owner_role: 'role key from your_team',
          requirement_keys: ['REQ-1'], depends_on: ['other ref'], budget_usd: 5, criteria: [{ kind: 'deterministic', statement: '…', independence: 'platform', check: { type: 'file_exists', path: '…' } }] }],
      },
    };
  }
  return contract;
}

/** Context for an independent reviewer: the artifact and the contract, never the producer's reasoning or claims. */
export async function buildReviewContext(q: Queryable, taskId: string, submissionId: string, diff: string) {
  const contract = await buildTaskContract(q, taskId, (await getTask(q, taskId)).owner_employee_id!);
  const evidence = await q.query<{ statement: string; result: string; independence: string }>(
    `SELECT cr.statement, e.result, e.independence FROM evidence e JOIN criteria cr ON cr.id = e.criterion_id WHERE e.submission_id = $1`, [submissionId]);
  const rubric = contract.acceptance_criteria.filter((c) => c.kind === 'rubric_review');
  return {
    you_review: 'Judge ONLY the rubric criteria listed under criteria_to_judge, against the verbatim requirements. Cite a location for every finding. Call review.record_verdict once with a verdict for each criterion.',
    task: contract.task, requirements: contract.requirements, constraints: contract.constraints,
    criteria_to_judge: rubric.map((c) => ({ id: c.id, statement: c.statement })),
    deterministic_results: evidence.rows,
    change: diff.slice(0, 60_000),
  };
}
