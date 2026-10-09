// Architecture rules for AI departments. These are the structural guarantees of the
// team design: separation of duties, Rule of Two, attenuation-friendly hierarchies,
// deterministic anchoring of verification, and human floors (architecture.md §8–9, §16.4).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DepartmentSchema, type Department, type Role } from './schema.js';
import { TOOLS_BY_NAME, toolTraits } from './toolCatalog.js';
import { compileTeam, isTeamSpec } from './teamSpec.js';

export interface Finding { level: 'error' | 'warning'; department: string; rule: string; message: string }

const DETERMINISTIC_KINDS = new Set(['deterministic', 'test_suite', 'schema', 'metric_threshold', 'external_reconciliation']);
const ARTIFACT_KINDS = new Set(['implementation', 'integration', 'remediation', 'operation', 'research']);
export const MAX_DEPTH_BELOW_CEO = 3;
export const MAX_SPAN = 8;

export function loadDepartmentFile(file: string): { department?: Department; findings: Finding[] } {
  const raw = parseYaml(readFileSync(file, 'utf8'));
  if (isTeamSpec(raw)) {
    const r = compileTeam(raw);
    return { department: r.department, findings: r.errors.map((m) => ({ level: 'error' as const, department: path.basename(file), rule: 'team_spec', message: m })) };
  }
  const parsed = DepartmentSchema.safeParse(raw);
  if (!parsed.success) {
    return { findings: parsed.error.issues.map((i) => ({ level: 'error', department: path.basename(file), rule: 'schema', message: `${i.path.join('.')}: ${i.message}` })) };
  }
  return { department: parsed.data, findings: [] };
}

export function loadDepartments(dir: string): { departments: Department[]; findings: Finding[] } {
  const departments: Department[] = [];
  const findings: Finding[] = [];
  if (!existsSync(dir)) return { departments, findings: [{ level: 'error', department: dir, rule: 'missing_dir', message: 'Template directory not found' }] };
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort()) {
    const r = loadDepartmentFile(path.join(dir, f));
    findings.push(...r.findings);
    if (r.department) departments.push(r.department);
  }
  findings.push(...validateOrganization(departments));
  return { departments, findings };
}

export function validateDepartment(d: Department): Finding[] {
  const out: Finding[] = [];
  const err = (rule: string, message: string) => out.push({ level: 'error', department: d.key, rule, message });
  const warn = (rule: string, message: string) => out.push({ level: 'warning', department: d.key, rule, message });
  const roles = new Map(d.roles.map((r) => [r.key, r]));

  if (roles.size !== d.roles.length) err('unique_roles', 'Role keys must be unique within a department');
  const head = roles.get(d.head);
  if (!head) err('head_exists', `Head role "${d.head}" is not defined`);
  else if (!head.can_manage) err('head_manages', `Head role "${d.head}" must have can_manage: true`);

  for (const r of d.roles) out.push(...validateRole(d, r, roles));

  // --- Structure / hierarchy ---
  const seatRoles = new Set(d.structure.map((s) => s.role));
  for (const s of d.structure) {
    if (!roles.has(s.role)) err('seat_role_exists', `Seat references unknown role "${s.role}"`);
    if (s.reports_to !== 'ceo' && !seatRoles.has(s.reports_to)) err('reports_to_exists', `"${s.role}" reports to "${s.reports_to}", which has no seat`);
    if (s.reports_to !== 'ceo' && !roles.get(s.reports_to)?.can_manage) err('manager_can_manage', `"${s.role}" reports to "${s.reports_to}", which cannot manage`);
  }
  for (const r of d.roles) if (!seatRoles.has(r.key)) warn('role_unseated', `Role "${r.key}" is defined but has no seat in the structure`);
  const headSeat = d.structure.find((s) => s.role === d.head);
  if (!headSeat || headSeat.reports_to !== 'ceo') err('head_reports_to_ceo', 'The department head must report to the CEO');

  // depth & cycles
  const parentOf = new Map(d.structure.map((s) => [s.role, s.reports_to]));
  for (const s of d.structure) {
    let depth = 1; let cur = s.reports_to; const seen = new Set([s.role]);
    while (cur !== 'ceo') {
      if (seen.has(cur)) { err('no_cycles', `Reporting cycle through "${cur}"`); break; }
      seen.add(cur); depth++; cur = parentOf.get(cur) ?? 'ceo';
    }
    if (depth > MAX_DEPTH_BELOW_CEO) err('max_depth', `"${s.role}" is ${depth} layers below the CEO (max ${MAX_DEPTH_BELOW_CEO})`);
  }
  // span of control
  const span = new Map<string, number>();
  for (const s of d.structure) span.set(s.reports_to, (span.get(s.reports_to) ?? 0) + s.count);
  for (const [mgr, n] of span) if (mgr !== 'ceo' && n > MAX_SPAN) err('span_of_control', `"${mgr}" has ${n} direct reports (max ${MAX_SPAN})`);

  // --- Separation of duties: reviewers sit outside the producer's management chain ---
  for (const r of d.roles) {
    if (!r.reviewer_role) continue;
    const reviewer = roles.get(r.reviewer_role);
    if (!reviewer) { err('reviewer_exists', `"${r.key}" names reviewer "${r.reviewer_role}", which is not defined`); continue; }
    if (reviewer.category !== 'reviewer' && reviewer.category !== 'qa') err('reviewer_category', `Reviewer "${reviewer.key}" must be category reviewer or qa`);
    if (reviewer.key === r.key) err('no_self_review', `"${r.key}" cannot review its own work`);
    const chain = chainOf(parentOf, r.key);
    if (chain.includes(reviewer.key)) err('reviewer_outside_chain', `Reviewer "${reviewer.key}" is in the management chain of "${r.key}"`);
    const reviewerMgr = parentOf.get(reviewer.key);
    if (reviewerMgr && reviewerMgr === parentOf.get(r.key) && reviewerMgr !== 'ceo')
      warn('reviewer_independence', `Reviewer "${reviewer.key}" reports to the same manager as "${r.key}" ("${reviewerMgr}")`);
  }

  // --- Workflows reference real roles; at least one stage has a CEO or human gate when risk floor >= R2 ---
  for (const w of d.workflows) for (const st of w.stages) {
    if (!roles.has(st.owner_role)) err('workflow_role', `Workflow "${w.key}" stage "${st.key}" uses unknown role "${st.owner_role}"`);
    else if (!roles.get(st.owner_role)!.task_kinds.includes(st.task_kind)) warn('workflow_task_kind', `Stage "${st.key}": role "${st.owner_role}" does not list task kind "${st.task_kind}"`);
  }
  if (['R2', 'R3'].includes(d.risk_floor) && !d.workflows.every((w) => w.stages.some((s) => s.gate === 'ceo_approval' || s.gate === 'human_acceptance')))
    err('human_gate', `Risk floor ${d.risk_floor} requires every workflow to include a human gate`);
  return out;
}

function chainOf(parentOf: Map<string, string>, role: string): string[] {
  const chain: string[] = []; let cur = parentOf.get(role); const seen = new Set<string>();
  while (cur && cur !== 'ceo' && !seen.has(cur)) { chain.push(cur); seen.add(cur); cur = parentOf.get(cur); }
  return chain;
}

function validateRole(d: Department, r: Role, roles: Map<string, Role>): Finding[] {
  const out: Finding[] = [];
  const err = (rule: string, message: string) => out.push({ level: 'error', department: d.key, rule, message: `[${r.key}] ${message}` });
  const warn = (rule: string, message: string) => out.push({ level: 'warning', department: d.key, rule, message: `[${r.key}] ${message}` });

  for (const t of [...r.tools, ...r.denied_tools]) if (!TOOLS_BY_NAME.has(t)) err('tool_exists', `Unknown tool "${t}"`);
  for (const t of r.tools) if (r.denied_tools.includes(t)) err('tool_conflict', `"${t}" is both granted and denied`);
  if (!r.tools.includes('ledger.get_task_contract')) err('task_contract', 'Every role must be able to read its Task Contract');

  // Managers
  const managerTools = ['ledger.create_subtask', 'ledger.assign_task', 'ledger.propose_plan', 'ledger.get_team_board'];
  if (!r.can_manage && r.tools.some((t) => managerTools.includes(t))) err('manager_tools', 'Only roles with can_manage may hold delegation tools');
  if (r.can_manage && !r.tools.includes('ledger.propose_plan')) err('manager_plans', 'Managers must propose plans through ledger.propose_plan');

  // Reviewers never produce or act externally
  if (r.category === 'reviewer') {
    if (!r.tools.includes('review.record_verdict')) err('reviewer_verdict', 'Reviewers must record verdicts via review.record_verdict');
    const writes = r.tools.filter((t) => ['A4', 'A5', 'A6'].includes(TOOLS_BY_NAME.get(t)?.actionClass ?? 'A0'));
    if (writes.length) err('reviewer_readonly', `Reviewers may not hold side-effecting tools: ${writes.join(', ')}`);
  }

  // Rule of Two (§16.4): never all three of untrusted input, private data, external communication
  const traits = toolTraits(r.tools);
  const trifecta = traits.has('reads_untrusted') && traits.has('reads_private') && traits.has('external_comms');
  const profile = r.rule_of_two_profile;
  if (trifecta && profile !== 'mixed') err('rule_of_two', 'Holds untrusted input + private data + external comms; must be profile "mixed" with approval-gated comms');
  if (profile === 'mixed') {
    const ungated = r.tools.filter((t) => TOOLS_BY_NAME.get(t)?.traits.includes('external_comms') && !['A5', 'A6'].includes(TOOLS_BY_NAME.get(t)!.actionClass));
    if (ungated.length) err('mixed_profile_gated', `Mixed-profile roles may only communicate externally via approval-gated (A5+) tools: ${ungated.join(', ')}`);
  }
  if ((profile === 'builder' || profile === 'communicator') && traits.has('reads_untrusted')) err('profile_untrusted', `Profile "${profile}" may not read untrusted content`);
  if ((profile === 'researcher' || profile === 'reviewer') && (traits.has('external_comms'))) err('profile_comms', `Profile "${profile}" may not communicate externally`);

  // Verification anchoring
  const producesArtifacts = r.task_kinds.some((k) => ARTIFACT_KINDS.has(k));
  if (producesArtifacts && !r.human_verified_only && !r.criteria_templates.some((c) => DETERMINISTIC_KINDS.has(c.kind)))
    err('deterministic_anchor', 'Artifact-producing roles need at least one deterministic criterion template (or human_verified_only with a reason)');
  for (const c of r.criteria_templates) {
    if (DETERMINISTIC_KINDS.has(c.kind) && c.independence === 'platform' && !c.check) warn('check_missing', `Deterministic criterion "${c.statement}" has no check; a connector verifier must supply one`);
    if (c.kind === 'rubric_review' && c.independence !== 'different_lineage_model' && c.independence !== 'human') err('rubric_independence', 'Rubric criteria must be judged by a different lineage or a human');
  }
  if (r.criteria_templates.some((c) => c.kind === 'rubric_review') && !r.reviewer_role) err('reviewer_for_rubric', 'Roles with rubric criteria must name a reviewer_role');

  // Human floors
  if (r.affects_individuals && !r.criteria_templates.some((c) => c.independence === 'human'))
    err('individuals_human', 'Work that significantly affects individuals requires a human criterion (GDPR Art. 22)');
  if (r.budget.per_run.max_cost_usd > r.budget.per_day_usd) err('budget_sane', 'Per-run budget exceeds per-day budget');
  if (r.escalation_path.at(-1) !== 'ceo') warn('escalation_to_ceo', 'Escalation path should end at the CEO');
  void roles;
  return out;
}

export function validateOrganization(departments: Department[]): Finding[] {
  const out: Finding[] = [];
  for (const d of departments) out.push(...validateDepartment(d));
  const seen = new Map<string, string>();
  for (const d of departments) for (const r of d.roles) {
    const prev = seen.get(r.key);
    if (prev) out.push({ level: 'error', department: d.key, rule: 'global_role_unique', message: `Role "${r.key}" also defined in "${prev}"` });
    seen.set(r.key, d.key);
  }
  const keys = new Set<string>();
  for (const d of departments) {
    if (keys.has(d.key)) out.push({ level: 'error', department: d.key, rule: 'department_unique', message: 'Duplicate department key' });
    keys.add(d.key);
  }
  return out;
}
