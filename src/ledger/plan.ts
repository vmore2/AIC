// Plan proposals from team leads (architecture.md §9.5.1). A plan is a structured proposal;
// it becomes work only after deterministic validation and the configured approval.
import { z } from 'zod';
import { wouldCreateCycle, DEFAULT_LIMITS } from '../domain/delegation.js';
import { RISK_TIERS, TASK_KINDS, riskRank, type RiskTier } from '../domain/types.js';
import { CriterionTemplateSchema, type CriterionTemplate, type Department, type Role } from '../org/schema.js';

/** Forgive common shapes models produce: {command: …} for {run: …}, {file: …} for {path: …}, missing independence. */
function normalizeCriteria(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((c) => {
    if (!c || typeof c !== 'object') return c;
    const o = { ...(c as Record<string, unknown>) };
    if (o['check'] && typeof o['check'] === 'object') {
      const k = { ...(o['check'] as Record<string, unknown>) };
      if (k['run'] === undefined && typeof (k['command'] ?? k['cmd']) === 'string') k['run'] = k['command'] ?? k['cmd'];
      if (k['type'] === 'command' && k['run'] === undefined && typeof k['script'] === 'string') k['run'] = k['script'];
      if (k['path'] === undefined && typeof (k['file'] ?? k['filename'] ?? k['filepath']) === 'string') k['path'] = k['file'] ?? k['filename'] ?? k['filepath'];
      if (k['type'] === undefined) k['type'] = k['run'] !== undefined ? 'command' : k['sections'] ? 'markdown_sections' : k['path'] !== undefined ? 'file_exists' : undefined;
      delete k['command']; delete k['cmd']; delete k['script']; delete k['file']; delete k['filename']; delete k['filepath'];
      o['check'] = k;
    }
    if (o['independence'] === undefined) o['independence'] = o['kind'] === 'rubric_review' ? 'different_lineage_model' : o['kind'] === 'human_judgment' ? 'human' : 'platform';
    return o;
  });
}

export const PlanTaskSchema = z.object({
  ref: z.string().min(1),
  title: z.string().min(3),
  kind: z.enum(TASK_KINDS),
  spec: z.string().min(10),
  owner_role: z.string(),
  requirement_keys: z.array(z.string()).min(1),
  criteria: z.preprocess(normalizeCriteria, z.array(CriterionTemplateSchema).default([])),
  depends_on: z.array(z.string()).default([]),
  budget_usd: z.number().positive(),
  risk_tier: z.enum(RISK_TIERS).optional(),
  weight: z.number().positive().default(1),
});
export const PlanSchema = z.object({
  summary: z.string().min(10),
  tasks: z.array(PlanTaskSchema).min(1),
  risks: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
  estimate: z.object({ cost_usd: z.number().nonnegative(), duration_hours: z.number().nonnegative().optional() }).optional(),
});
export type Plan = z.infer<typeof PlanSchema>;
export type PlanTask = z.infer<typeof PlanTaskSchema>;

export interface PlanContext {
  department: Department;
  leadRoleKey: string;
  /** Requirements this plan must cover (the planning task's pinned refs). */
  requirementKeys: string[];
  /** Verbatim requirement texts by key: files they name become mandatory, platform-checked deliverables. */
  requirementTexts?: Record<string, string>;
  /** All active requirement keys tasks may reference (defaults to requirementKeys). */
  knownRequirementKeys?: string[];
  budgetRemaining: number;
  riskFloor: RiskTier;
  settings: Record<string, string>;
}

export interface ResolvedPlanTask extends Omit<PlanTask, 'criteria' | 'risk_tier'> { criteria: CriterionTemplate[]; risk_tier: RiskTier; tool_grants: string[] }
export interface PlanValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  coverage: Record<string, string[]>;
  tasks: ResolvedPlanTask[];
}

const DETERMINISTIC = new Set(['deterministic', 'test_suite', 'schema', 'metric_threshold', 'external_reconciliation']);
const ARTIFACT_KINDS = new Set(['implementation', 'integration', 'remediation', 'operation', 'research']);

export function substitute(s: string, settings: Record<string, string>): string {
  return s.replace(/\$\{(\w+)\}/g, (_, k: string) => settings[k] ?? `\${${k}}`);
}

function resolveCriteria(criteria: CriterionTemplate[], settings: Record<string, string>): CriterionTemplate[] {
  return criteria.map((c) => {
    if (!c.check) return c;
    if (c.check.type === 'command') return { ...c, check: { ...c.check, run: substitute(c.check.run, settings) } };
    return c;
  });
}

/** File paths a requirement names explicitly ("src/cart.js", "docs/SPEC.md", "README.md"). URLs are ignored. */
export function namedPaths(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)+[\w-]+(?:\.[\w-]+)*\.[A-Za-z0-9]{1,8}|[\w-]+(?:\.[\w-]+)*\.(?:md|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|sql|html|css|csv|txt))(?=$|[\s`'",;:)\]]|\.(?:\s|$))/g;
  for (const m of text.matchAll(re)) {
    const p = m[1]!.replace(/^\.\//, '');
    if (/^https?:|^www\./i.test(p) || p.includes('..') || p.startsWith('/')) continue;
    out.add(p);
  }
  return [...out];
}

export function validatePlan(raw: unknown, ctx: PlanContext): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = PlanSchema.safeParse(raw);
  const hint = (p: (string | number)[]) => p[0] === 'tasks' && p.length === 1 ? ' (a non-empty tasks array inside plan)'
    : p.includes('check') ? ' — a check is {"type":"command","run":"node --test"} or {"type":"file_exists","path":"src/x.js"} or {"type":"markdown_sections","path":"docs/X.md","sections":["Goals"]}; or drop the criterion (role checks and named files are added automatically)'
    : p.includes('criteria') ? ' — a criterion is {"kind":"rubric_review","statement":"…"} (judged by the reviewer) or {"kind":"deterministic","statement":"…","check":{…}}' : '';
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `plan.${i.path.join('.')}: ${i.message}${hint(i.path)}`), warnings, coverage: {}, tasks: [] };
  const plan = parsed.data;
  const roles = new Map<string, Role>(ctx.department.roles.map((r) => [r.key, r]));
  const leadsTeam = new Set(ctx.department.structure.filter((s) => s.reports_to === ctx.leadRoleKey).map((s) => s.role).concat(ctx.leadRoleKey));

  const refs = new Set<string>();
  for (const t of plan.tasks) {
    if (refs.has(t.ref)) errors.push(`Duplicate task ref "${t.ref}"`);
    refs.add(t.ref);
  }
  if (plan.tasks.length > DEFAULT_LIMITS.maxChildren) errors.push(`Plan has ${plan.tasks.length} tasks (max ${DEFAULT_LIMITS.maxChildren}); group work into larger tasks`);

  // QA tests run against the code they test: a QA task waits for the build tasks covering the same
  // requirements (it still writes its tests from the requirement text, independently of the builders).
  for (const t of plan.tasks) {
    if (roles.get(t.owner_role)?.category !== 'qa' || !ARTIFACT_KINDS.has(t.kind)) continue;
    const builds = plan.tasks.filter((o) => o !== t && roles.get(o.owner_role)?.category !== 'qa' && ARTIFACT_KINDS.has(o.kind)
      && o.requirement_keys.some((k) => t.requirement_keys.includes(k)) && !o.depends_on.includes(t.ref));
    const added = builds.map((o) => o.ref).filter((r) => !t.depends_on.includes(r));
    if (added.length) { t.depends_on.push(...added); warnings.push(`[${t.ref}] tests will start after ${added.join(', ')} so they can run against the delivered code`); }
  }
  const edges: { taskId: string; dependsOn: string }[] = [];
  const resolved: ResolvedPlanTask[] = [];
  const coverage: Record<string, string[]> = Object.fromEntries(ctx.requirementKeys.map((k) => [k, []]));
  const known = new Set([...(ctx.knownRequirementKeys ?? []), ...ctx.requirementKeys]);
  let budget = 0;
  const deliverers = ctx.department.roles.filter((r) => r.category !== 'reviewer' && r.task_kinds.some((k) => ARTIFACT_KINDS.has(k)))
    .map((r) => `${r.key} (${r.task_kinds.filter((k) => ARTIFACT_KINDS.has(k)).join('/')})`);

  for (const t of plan.tasks) {
    const role = roles.get(t.owner_role);
    if (!role) { errors.push(`[${t.ref}] unknown owner_role "${t.owner_role}"`); continue; }
    if (role.category === 'reviewer') errors.push(`[${t.ref}] reviewers are assigned by the platform, not planned as owners`);
    // QA roles sit outside the producer chain by design but take test-authoring work from the plan.
    if (!leadsTeam.has(role.key) && role.category !== 'qa') errors.push(`[${t.ref}] "${role.key}" is not on the lead's team`);
    if (!role.task_kinds.includes(t.kind)) errors.push(`[${t.ref}] role "${role.key}" cannot own task kind "${t.kind}"`);
    for (const k of t.requirement_keys) {
      if (!known.has(k)) errors.push(`[${t.ref}] unknown requirement "${k}"`);
      // Coverage means delivering the requirement: analysis-only tasks (discovery/decision) don't count
      // when the team has someone who can produce it.
      else if (k in coverage && (ARTIFACT_KINDS.has(t.kind) || !deliverers.length)) coverage[k]!.push(t.ref);
    }
    for (const d of t.depends_on) {
      if (!refs.has(d)) errors.push(`[${t.ref}] depends on unknown ref "${d}"`);
      else if (wouldCreateCycle(edges, t.ref, d)) errors.push(`[${t.ref}] dependency on "${d}" creates a cycle`);
      else edges.push({ taskId: t.ref, dependsOn: d });
    }
    // A criterion the platform is supposed to verify must say HOW; otherwise nothing can ever verify it and
    // the task can only end "uncertain". Tell the lead exactly how to fix it.
    for (const c of t.criteria) if (DETERMINISTIC.has(c.kind) && !c.check)
      errors.push(`[${t.ref}] criterion "${c.statement}" is marked ${c.kind} but has no check the platform can run. Add "check": {"type": "file_exists", "path": "…"} `
        + `or {"type": "command", "run": "…"} (or markdown_sections / no_placeholder_text), or make it {"kind": "rubric_review", "independence": "different_lineage_model"} so the independent reviewer judges it.`);
    const criteria = resolveCriteria([...role.criteria_templates, ...t.criteria], ctx.settings);
    // Files a requirement names must exist in the delivered work — checked by the platform, not judged.
    if (ARTIFACT_KINDS.has(t.kind)) for (const k of t.requirement_keys) for (const p of namedPaths(ctx.requirementTexts?.[k] ?? '')) {
      if (criteria.some((c) => c.check && 'path' in c.check && c.check.path === p)) continue;
      criteria.push({ kind: 'deterministic', statement: `${p} exists (named in ${k})`, independence: 'platform', required: true, check: { type: 'file_exists', path: p } });
    }
    if (ARTIFACT_KINDS.has(t.kind) && !role.human_verified_only && !criteria.some((c) => DETERMINISTIC.has(c.kind)))
      errors.push(`[${t.ref}] needs at least one deterministic acceptance criterion`);
    if (criteria.some((c) => c.kind === 'rubric_review') && !role.reviewer_role) errors.push(`[${t.ref}] rubric criteria need a reviewer role`);
    for (const c of criteria) if (c.check?.type === 'command' && /\$\{\w+\}/.test(c.check.run))
      errors.push(`[${t.ref}] criterion "${c.statement}" uses an unset project setting: ${c.check.run}`);
    const tier = t.risk_tier ?? ctx.riskFloor;
    if (riskRank(tier) < riskRank(ctx.riskFloor)) errors.push(`[${t.ref}] risk tier ${tier} is below the objective floor ${ctx.riskFloor}`);
    budget += t.budget_usd;
    resolved.push({ ...t, criteria, risk_tier: riskRank(tier) < riskRank(ctx.riskFloor) ? ctx.riskFloor : tier, tool_grants: role.tools.filter((x) => !role.denied_tools.includes(x)) });
  }
  for (const [k, covering] of Object.entries(coverage)) if (!covering.length)
    errors.push(`Requirement ${k} is not covered by any task that delivers it${deliverers.length ? ` — add a task owned by one of: ${deliverers.join(', ')}` : ''}`);
  if (budget > ctx.budgetRemaining + 1e-9) errors.push(`Plan budget $${budget.toFixed(2)} exceeds remaining objective budget $${ctx.budgetRemaining.toFixed(2)}`);
  if (plan.open_questions.length) warnings.push(`${plan.open_questions.length} open question(s) for the CEO`);
  return { ok: errors.length === 0, errors, warnings, coverage, tasks: resolved };
}
