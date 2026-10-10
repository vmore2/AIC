// Plan proposals from team leads (architecture.md §9.5.1). A plan is a structured proposal;
// it becomes work only after deterministic validation and the configured approval.
import { z } from 'zod';
import { wouldCreateCycle, DEFAULT_LIMITS } from '../domain/delegation.js';
import { RISK_TIERS, TASK_KINDS, riskRank, type RiskTier } from '../domain/types.js';
import { CriterionTemplateSchema, type CriterionTemplate, type Department, type Role } from '../org/schema.js';

export const PlanTaskSchema = z.object({
  ref: z.string().min(1),
  title: z.string().min(3),
  kind: z.enum(TASK_KINDS),
  spec: z.string().min(10),
  owner_role: z.string(),
  requirement_keys: z.array(z.string()).min(1),
  criteria: z.array(CriterionTemplateSchema).default([]),
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

export function validatePlan(raw: unknown, ctx: PlanContext): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `plan.${i.path.join('.')}: ${i.message}${i.path[0] === 'tasks' && i.path.length === 1 ? ' (a non-empty tasks array inside plan)' : ''}`), warnings, coverage: {}, tasks: [] };
  const plan = parsed.data;
  const roles = new Map<string, Role>(ctx.department.roles.map((r) => [r.key, r]));
  const leadsTeam = new Set(ctx.department.structure.filter((s) => s.reports_to === ctx.leadRoleKey).map((s) => s.role).concat(ctx.leadRoleKey));

  const refs = new Set<string>();
  for (const t of plan.tasks) {
    if (refs.has(t.ref)) errors.push(`Duplicate task ref "${t.ref}"`);
    refs.add(t.ref);
  }
  if (plan.tasks.length > DEFAULT_LIMITS.maxChildren) errors.push(`Plan has ${plan.tasks.length} tasks (max ${DEFAULT_LIMITS.maxChildren}); group work into larger tasks`);

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
    const criteria = resolveCriteria([...role.criteria_templates, ...t.criteria], ctx.settings);
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
