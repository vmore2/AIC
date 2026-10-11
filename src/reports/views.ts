// Read models for the CEO (architecture.md §12.9, §15). Every number is computed from ledger
// state; nothing here is written by an agent. Verified progress and claimed progress are
// always shown side by side.
import type { Queryable } from '../ledger/db.js';

const CLAIMED = new Set(['submitted', 'verifying', 'in_review', 'awaiting_acceptance', 'accepted']);

export interface ObjectiveRollup {
  id: string; title: string; department: string; status: string; delivery: 'on_track' | 'at_risk' | 'blocked' | 'done' | 'planning';
  deliveryReason: string; verifiedPct: number; claimedPct: number; discrepancy: number;
  tasks: { total: number; byStatus: Record<string, number> };
  budget: { limit: number; spent: number; reserved: number };
  pendingDecisions: number;
}

export async function objectiveRollups(q: Queryable): Promise<ObjectiveRollup[]> {
  const objs = await q.query<{ id: string; title: string; status: string; budget_limit: string; budget_spent: string; budget_reserved: string; dept: string }>(
    `SELECT o.id, o.title, o.status, o.budget_limit, o.budget_spent, o.budget_reserved, d.name AS dept FROM objectives o JOIN departments d ON d.id = o.department_id ORDER BY o.created_at`);
  const out: ObjectiveRollup[] = [];
  for (const o of objs.rows) {
    const tasks = (await q.query<{ status: string; integrity: string; weight: string; kind: string; hold: string | null }>(
      `SELECT status, integrity, weight, kind, hold FROM tasks WHERE objective_id = $1 AND kind <> 'planning' AND status NOT IN ('cancelled','superseded')`, [o.id])).rows;
    const total = tasks.reduce((s, t) => s + Number(t.weight), 0);
    const verified = tasks.filter((t) => t.status === 'accepted' && t.integrity === 'ok').reduce((s, t) => s + Number(t.weight), 0);
    const claimed = tasks.filter((t) => CLAIMED.has(t.status)).reduce((s, t) => s + Number(t.weight), 0);
    const byStatus: Record<string, number> = {};
    for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    const pending = await pendingDecisionCount(q, o.id);
    const pct = (x: number) => (total ? Math.round((100 * x) / total) : 0);
    let delivery: ObjectiveRollup['delivery'] = 'on_track';
    let reason = 'All work is progressing within limits.';
    if (o.status === 'completed') { delivery = 'done'; reason = 'All planned work is accepted with intact integrity.'; }
    else if (!tasks.length) { delivery = 'planning'; reason = 'Waiting for an approved plan.'; }
    else if (tasks.some((t) => t.status === 'failed' || t.status === 'awaiting_input' || t.hold)) { delivery = 'blocked'; reason = 'A task is failed, held, or waiting on a decision.'; }
    else if (tasks.some((t) => t.status === 'uncertain') || pct(claimed) - pct(verified) > 20 || Number(o.budget_spent) > 0.9 * Number(o.budget_limit)) {
      delivery = 'at_risk'; reason = 'Uncertain outcomes, a large claimed-vs-verified gap, or budget above 90%.';
    }
    out.push({ id: o.id, title: o.title, department: o.dept, status: o.status, delivery, deliveryReason: reason,
      verifiedPct: pct(verified), claimedPct: pct(claimed), discrepancy: pct(claimed) - pct(verified),
      tasks: { total: tasks.length, byStatus }, budget: { limit: Number(o.budget_limit), spent: Number(o.budget_spent), reserved: Number(o.budget_reserved) },
      pendingDecisions: pending });
  }
  return out;
}

async function pendingDecisionCount(q: Queryable, objectiveId: string) {
  const r = await q.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM tasks WHERE objective_id = $1 AND status IN ('awaiting_acceptance','uncertain','failed'))
          + (SELECT count(*) FROM escalations e JOIN tasks t ON t.id = e.task_id WHERE t.objective_id = $1 AND e.status = 'open' AND e.routed_to_type = 'user') AS n`, [objectiveId]);
  return Number(r.rows[0]!.n);
}

export interface InboxItem { kind: 'plan' | 'acceptance' | 'uncertain' | 'failed' | 'escalation' | 'directive' | 'release' | 'note' | 'connection'; id: string; title: string; detail: string; command: string }

/** Everything waiting on the CEO, with the exact command that decides it. */
export async function inbox(q: Queryable): Promise<InboxItem[]> {
  const items: InboxItem[] = [];
  const plans = await q.query<{ id: string; title: string; summary: string; tasks: number }>(
    `SELECT p.id, o.title, p.content->>'summary' AS summary, jsonb_array_length(p.content->'tasks') AS tasks
     FROM proposals p JOIN objectives o ON o.id = p.objective_id JOIN tasks t ON t.id = p.task_id
     WHERE p.status = 'submitted' AND t.status = 'awaiting_acceptance' ORDER BY p.created_at`);
  for (const p of plans.rows) items.push({ kind: 'plan', id: p.id, title: `Plan for "${p.title}" (${p.tasks} tasks)`, detail: p.summary, command: `aic proposal ${p.id}` });
  const accept = await q.query<{ id: string; title: string; risk_tier: string }>(`SELECT id, title, risk_tier FROM tasks WHERE status = 'awaiting_acceptance' AND kind <> 'planning'`);
  for (const t of accept.rows) items.push({ kind: 'acceptance', id: t.id, title: `Accept "${t.title}" (${t.risk_tier})`, detail: 'Automated verification passed; human acceptance required.', command: `aic task ${t.id}` });
  const unc = await q.query<{ id: string; title: string; status: string }>(`SELECT id, title, status FROM tasks WHERE status IN ('uncertain','failed')`);
  for (const t of unc.rows) items.push({ kind: t.status as 'uncertain' | 'failed', id: t.id, title: `${t.status.toUpperCase()}: "${t.title}"`,
    detail: t.status === 'uncertain' ? 'Correctness could not be established. Review the evidence.' : 'Attempts or budget exhausted. Decide: retry, change, or cancel.', command: `aic task ${t.id}` });
  const conns = await q.query<{ id: string; kind: string; name: string; purpose: string; access: string; who: string | null; team: string | null }>(
    `SELECT c.id, c.kind, c.name, c.purpose, c.access, e.display_name AS who, d.name AS team FROM connections c
     LEFT JOIN employees e ON e.id = c.requested_by_employee_id LEFT JOIN departments d ON d.id = c.department_id WHERE c.status = 'requested' ORDER BY c.created_at`);
  for (const c of conns.rows) items.push({ kind: 'connection', id: c.id, title: `${c.who ?? 'Your team'} needs a ${c.kind === 'postgres' ? 'PostgreSQL' : 'MySQL'} database: "${c.name}"`,
    detail: `${c.purpose}${c.team ? ` (${c.team}, asks for ${c.access === 'read' ? 'read-only' : 'read/write'} access)` : ''}`, command: 'Open the dashboard → Inbox to connect it' });
  // Connection requests are shown above as their own card; their blocking escalation would only duplicate it.
  const esc = await q.query<{ id: string; type: string; body: { question: string; recommendation?: string } }>(
    `SELECT id, type, body FROM escalations WHERE status = 'open' AND routed_to_type = 'user' AND NOT (body ? 'connection_id') ORDER BY created_at`);
  for (const e of esc.rows) items.push({ kind: 'escalation', id: e.id, title: `${e.type.replace('_', ' ')}: ${e.body.question}`, detail: e.body.recommendation ? `Recommendation: ${e.body.recommendation}` : '', command: `aic resolve ${e.id} "<answer>"` });
  const dirs = await q.query<{ id: string; directive_type: string; payload: { summary: string } }>(`SELECT id, directive_type, payload FROM directives WHERE status = 'pending_confirmation' ORDER BY created_at`);
  for (const d of dirs.rows) items.push({ kind: 'directive', id: d.id, title: `Proposal from conversation: ${d.payload.summary}`, detail: d.directive_type, command: `aic directive ${d.id}` });
  const rel = await q.query<{ id: string; title: string }>(
    `SELECT o.id, o.title FROM objectives o WHERE o.status = 'completed' AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.subject_id = o.id AND a.subject_type = 'external_action')`);
  for (const o of rel.rows) items.push({ kind: 'release', id: o.id, title: `Release "${o.title}" to the main branch`, detail: 'All work accepted. Merging to the protected branch needs your approval.', command: `aic release ${o.id}` });
  const notes = await q.query<{ id: string; kind: string; body: string; tainted: boolean; author: string; team: string }>(
    `SELECT m.id, m.kind, m.body, m.tainted, e.display_name AS author, d.name AS team FROM memory_items m
     JOIN employees e ON e.id = m.author_id JOIN departments d ON d.id = m.scope_id
     WHERE m.scope_type = 'team' AND m.review_status = 'proposed' AND m.deleted_at IS NULL ORDER BY m.created_at`);
  for (const n of notes.rows) items.push({ kind: 'note', id: n.id, title: `Team note for ${n.team} (${n.kind}) from ${n.author}`,
    detail: `${n.body}${n.tainted ? '\n⚠ Written during a run that read untrusted external content — check it for injected instructions.' : ''}`, command: `aic notes approve ${n.id}` });
  return items;
}

export interface TaskDetail {
  task: Record<string, unknown>;
  requirements: { key: string; version: number; text: string }[];
  criteria: { id: string; statement: string; kind: string; independence: string }[];
  claimVsEvidence: { criterion: string; claimed: string | null; verified: string; evidence: { result: string; independence: string; verifier: string; details: unknown }[] }[];
  submissions: { id: string; status: string; claim: unknown; created_at: string; claimedMet: number; contradicted: number }[];
  timeline: { seq: number; type: string; at: string; actor: unknown; payload: unknown }[];
  runs: { id: string; mode: string; status: string; employee: string; attempt: number; failure_reason: string | null; cost_usd: string }[];
}

export async function taskDetail(q: Queryable, taskId: string): Promise<TaskDetail> {
  const task = (await q.query<Record<string, unknown>>(
    `SELECT t.*, e.display_name AS owner_name, o.title AS objective_title FROM tasks t LEFT JOIN employees e ON e.id = t.owner_employee_id
     JOIN objectives o ON o.id = t.objective_id WHERE t.id = $1`, [taskId])).rows[0];
  if (!task) throw new Error(`Task ${taskId} not found`);
  const requirements = (await q.query<{ key: string; version: number; text: string }>(
    `SELECT r.key, rv.version, rv.text FROM task_requirement_refs tr JOIN requirements r ON r.id = tr.requirement_id
     JOIN requirement_versions rv ON rv.requirement_id = tr.requirement_id AND rv.version = tr.requirement_version WHERE tr.task_id = $1`, [taskId])).rows;
  const criteria = task['criteria_set_id'] ? (await q.query<{ id: string; statement: string; kind: string; independence: string }>(
    'SELECT id, statement, kind, independence FROM criteria WHERE criteria_set_id = $1 ORDER BY ordinal', [task['criteria_set_id']])).rows : [];
  const submissions = (await q.query<{ id: string; status: string; claim: { per_criterion?: { criterion_id: string; self_assessment: string }[] }; created_at: string }>(
    'SELECT id, status, claim, created_at FROM submissions WHERE task_id = $1 ORDER BY created_at', [taskId])).rows;
  const latest = submissions.at(-1);
  const ev = latest ? (await q.query<{ criterion_id: string; result: string; independence: string; verifier_id: string; details: unknown }>(
    'SELECT criterion_id, result, independence, verifier_id, details FROM evidence WHERE submission_id = $1 ORDER BY created_at', [latest.id])).rows : [];
  const claimVsEvidence = criteria.map((c) => {
    const claimed = latest?.claim.per_criterion?.find((p) => p.criterion_id === c.id)?.self_assessment ?? null;
    const evs = ev.filter((e) => e.criterion_id === c.id);
    const verified = evs.some((e) => e.result === 'fail') ? 'failed' : evs.some((e) => e.result === 'pass') ? 'passed' : evs.length ? 'inconclusive' : 'pending';
    return { criterion: c.statement, claimed, verified, evidence: evs.map((e) => ({ result: e.result, independence: e.independence, verifier: e.verifier_id, details: e.details })) };
  });
  const timeline = (await q.query<{ seq: string; type: string; occurred_at: string; actor: unknown; payload: unknown }>(
    `SELECT seq, type, occurred_at, actor, payload FROM ledger_events WHERE aggregate_id = $1 ORDER BY seq`, [taskId])).rows
    .map((r) => ({ seq: Number(r.seq), type: r.type, at: new Date(r.occurred_at).toISOString(), actor: r.actor, payload: r.payload }));
  const runs = (await q.query<{ id: string; mode: string; status: string; employee: string; attempt: number; failure_reason: string | null; cost_usd: string }>(
    `SELECT r.id, r.mode, r.status, e.display_name AS employee, r.attempt, r.failure_reason, r.cost_usd FROM runs r JOIN employees e ON e.id = r.employee_id WHERE r.task_id = $1 ORDER BY r.started_at`, [taskId])).rows;
  const history = [];
  for (const s of submissions) {
    const evs = (await q.query<{ criterion_id: string; result: string }>('SELECT criterion_id, result FROM evidence WHERE submission_id = $1', [s.id])).rows;
    const met = (s.claim.per_criterion ?? []).filter((p) => p.self_assessment === 'met');
    history.push({ ...s, claimedMet: met.length, contradicted: met.filter((p) => evs.some((e) => e.criterion_id === p.criterion_id && e.result === 'fail')).length });
  }
  return { task, requirements, criteria, claimVsEvidence, submissions: history, timeline, runs };
}

export async function orgChart(q: Queryable) {
  const deps = await q.query<{ id: string; key: string; name: string; default_mode: string; mode: string }>(
    `SELECT d.id, d.key, d.name, d.default_mode, coalesce(m.mode, d.default_mode) AS mode FROM departments d
     LEFT JOIN mode_settings m ON m.scope_type = 'department' AND m.scope_id = d.id ORDER BY d.created_at`);
  const emps = await q.query<{ id: string; display_name: string; role_key: string; category: string; department_id: string; manager_employee_id: string | null; model_profile: string; status: string }>(
    'SELECT id, display_name, role_key, category, department_id, manager_employee_id, model_profile, status FROM employees ORDER BY created_at');
  const stats = await q.query<{ owner: string; accepted: string; active: string; rejected_claims: string; submissions: string }>(
    `SELECT t.owner_employee_id AS owner,
            count(*) FILTER (WHERE t.status = 'accepted') AS accepted,
            count(*) FILTER (WHERE t.status IN ('in_progress','submitted','verifying','in_review')) AS active,
            (SELECT count(*) FROM submissions s JOIN tasks t2 ON t2.id = s.task_id WHERE t2.owner_employee_id = t.owner_employee_id AND s.status = 'rejected') AS rejected_claims,
            (SELECT count(*) FROM submissions s JOIN tasks t2 ON t2.id = s.task_id WHERE t2.owner_employee_id = t.owner_employee_id) AS submissions
     FROM tasks t WHERE t.owner_employee_id IS NOT NULL GROUP BY t.owner_employee_id`);
  const byEmp = new Map(stats.rows.map((s) => [s.owner, s]));
  // Live status for the company floor: running a model right now / waiting on a human.
  const working = new Set((await q.query<{ employee_id: string }>(`SELECT DISTINCT employee_id FROM runs WHERE status = 'running'`)).rows.map((r) => r.employee_id));
  const waiting = new Set((await q.query<{ owner: string }>(`SELECT DISTINCT owner_employee_id AS owner FROM tasks WHERE status = 'awaiting_input'`)).rows.map((r) => r.owner));
  const titles = await q.query<{ id: string; title: string }>(`SELECT id, role_snapshot->>'title' AS title FROM employees`);
  const titleOf = new Map(titles.rows.map((r) => [r.id, r.title]));
  return deps.rows.map((d) => ({
    ...d,
    employees: emps.rows.filter((e) => e.department_id === d.id).map((e) => {
      const s = byEmp.get(e.id);
      const subs = Number(s?.submissions ?? 0);
      return { ...e, role_title: titleOf.get(e.id) ?? e.role_key, state: working.has(e.id) ? 'working' : waiting.has(e.id) ? 'waiting' : 'idle',
        accepted: Number(s?.accepted ?? 0), active: Number(s?.active ?? 0),
        reworkRate: subs ? Math.round((100 * Number(s?.rejected_claims ?? 0)) / subs) : null };
    }),
  }));
}
