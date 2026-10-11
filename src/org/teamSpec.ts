// Team specs: the easy way to define a team. You list the roles in plain language;
// the platform derives tools, budgets, acceptance criteria, review chain, Rule-of-Two
// profile, reporting lines, workflows, and prompts. The result is a full Department
// that must still pass every architecture rule in validate.ts.
import { z } from 'zod';
import { DepartmentSchema, type CriterionTemplate, type Department, type Role } from './schema.js';
import { TOOLS_BY_NAME, toolTraits } from './toolCatalog.js';
import type { Mode, RiskTier, TaskKind } from '../domain/types.js';

/** What a role works with → the tools it gets. Reviewers only get the read-only (A0) tools. */
export const CAPABILITIES = {
  code: { tools: ['sandbox.exec', 'repo.commit_and_push'], label: 'Writes and tests code in its own branch' },
  documents: { tools: [], label: 'Writes documents (always available)' },
  web_research: { tools: ['web.search', 'web.fetch', 'docs.read_external'], label: 'Reads the public web and external documents (untrusted)' },
  design_files: { tools: ['design.read', 'design.write'], label: 'Reads and edits design files' },
  email_drafts: { tools: ['email.draft'], label: 'Drafts emails (not sent)' },
  send_email: { tools: ['email.draft', 'email.send_external'], label: 'Sends external email (always needs approval)' },
  crm: { tools: ['crm.read', 'crm.update'], label: 'Reads and updates the CRM' },
  tickets: { tools: ['ticket.read', 'ticket.create'], label: 'Reads and creates tickets' },
  analytics: { tools: ['analytics.query', 'sandbox.exec'], label: 'Runs read-only analytics queries' },
  databases: { tools: ['connections.request', 'db.schema', 'db.query', 'db.execute'], label: 'Uses databases the CEO connects (asks for credentials; writes only with read/write access)' },
  finance_records: { tools: ['finance.read_ledger'], label: 'Reads accounting records' },
  contracts: { tools: ['contracts.read'], label: 'Reads contracts' },
  hr_records: { tools: ['hris.read'], label: 'Reads HR records (restricted)' },
  calendar: { tools: ['calendar.schedule'], label: 'Schedules meetings' },
  publish: { tools: ['social.publish'], label: 'Publishes externally (always needs approval)' },
  customer_inbox: { tools: ['email.read_inbound', 'ticket.read', 'crm.read', 'support.reply_customer'], label: 'Reads customer messages and replies (replies need approval)' },
} as const;
export type Capability = keyof typeof CAPABILITIES;

const MODE_ALIASES: Record<string, Mode> = {
  autonomous: 'M1', exception_escalation: 'M2', exceptions: 'M2', milestone_gates: 'M3', milestones: 'M3',
  plan_gates: 'M4', plans: 'M4', supervised: 'M5', manual: 'M5', safe_mode: 'M6',
};
const RISK_ALIASES: Record<string, RiskTier> = { low: 'R0', standard: 'R1', high: 'R2', critical: 'R3' };

const Deliverable = z.union([
  z.object({ document: z.string(), sections: z.array(z.string()).min(1).optional() }),
  z.object({ file: z.string() }),
  z.object({ check: z.string().min(1), says: z.string().optional() }),
]);

export const RoleSpecSchema = z.object({
  title: z.string().min(2),
  key: z.string().regex(/^[a-z][a-z0-9_]*$/).optional(),
  does: z.string().min(20, 'Describe what this role does in at least one full sentence'),
  count: z.number().int().min(1).max(10).default(1),
  lead: z.boolean().default(false),
  qa: z.boolean().default(false),
  /** Titles of roles whose work this role independently reviews. */
  reviews: z.array(z.string()).default([]),
  reports_to: z.string().optional(),
  works_with: z.array(z.enum(Object.keys(CAPABILITIES) as [Capability, ...Capability[]])).default(['documents']),
  delivers: z.array(Deliverable).default([]),
  /** A human must accept this role's work (e.g. "The CEO accepts the visual direction"). */
  human_judges: z.string().optional(),
  /** Work that significantly affects individuals (hiring, performance): always human-decided. */
  affects_people: z.boolean().default(false),
  responsibilities: z.array(z.string()).optional(),
  instructions: z.string().optional(),
  budget_per_run_usd: z.number().positive().optional(),
  /** Escape hatch: any field of the full Role schema. */
  advanced: z.record(z.unknown()).optional(),
});
export type RoleSpec = z.infer<typeof RoleSpecSchema>;

export const TeamSpecSchema = z.object({
  team: z.string().regex(/^[a-z][a-z0-9_]*$/, 'team must be a snake_case key, e.g. growth_marketing'),
  name: z.string().min(2),
  version: z.number().int().positive().default(1),
  purpose: z.string().min(20, 'Describe the team purpose in a sentence or two'),
  recommended: z.boolean().default(false),
  publisher: z.string().optional(),
  mode: z.string().default('plan_gates'),
  risk: z.string().default('standard'),
  roles: z.array(RoleSpecSchema).min(2, 'A team needs at least a lead and one other role'),
  never_autonomous: z.array(z.string()).default([]),
  kpis: z.array(z.string()).optional(),
});
export type TeamSpec = z.infer<typeof TeamSpecSchema>;

export const isTeamSpec = (raw: unknown): boolean => !!raw && typeof raw === 'object' && 'team' in (raw as object);

export const keyOf = (title: string) => title.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').replace(/^(\d)/, 'r_$1');

const BASE = ['ledger.get_task_contract', 'ledger.raise_blocker', 'ledger.ask_question', 'knowledge.search'];
const PRODUCER = ['ledger.submit_work', 'ledger.post_update', 'knowledge.remember', 'knowledge.propose_team_note', 'fs.read', 'fs.write', 'fs.list'];
const MANAGER = ['knowledge.propose_team_note', 'ledger.get_team_board', 'ledger.propose_plan', 'ledger.create_subtask', 'ledger.assign_task', 'ledger.post_update', 'ledger.propose_directive', 'ledger.submit_work', 'fs.read', 'fs.write', 'fs.list'];
const REVIEWER = ['ledger.get_task_contract', 'review.record_verdict', 'fs.read', 'fs.list', 'knowledge.search'];
const EXTERNAL_ACTION_TOOLS = new Set(['email.send_external', 'social.publish', 'support.reply_customer', 'calendar.schedule', 'crm.update', 'ticket.create']);

export interface CompileResult { department?: Department; errors: string[]; notes: string[] }

export function compileTeam(raw: unknown): CompileResult {
  const parsed = TeamSpecSchema.safeParse(raw);
  if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'team'}: ${i.message}`), notes: [] };
  const spec = parsed.data;
  const errors: string[] = [];
  const notes: string[] = [];

  const mode = MODE_ALIASES[spec.mode.toLowerCase()] ?? (/^M[1-6]$/.test(spec.mode) ? (spec.mode as Mode) : undefined);
  if (!mode) errors.push(`mode "${spec.mode}" is not one of: ${Object.keys(MODE_ALIASES).join(', ')}`);
  const risk = RISK_ALIASES[spec.risk.toLowerCase()] ?? (/^R[0-3]$/.test(spec.risk) ? (spec.risk as RiskTier) : undefined);
  if (!risk) errors.push(`risk "${spec.risk}" is not one of: ${Object.keys(RISK_ALIASES).join(', ')}`);

  const leads = spec.roles.filter((r) => r.lead);
  if (leads.length !== 1) errors.push(`Exactly one role must have "lead: true" (found ${leads.length})`);
  const byTitle = new Map(spec.roles.map((r) => [r.title.toLowerCase(), r]));
  const keyFor = (r: RoleSpec) => r.key ?? keyOf(r.title);
  const keys = spec.roles.map(keyFor);
  if (new Set(keys).size !== keys.length) errors.push('Two roles produce the same key; give one an explicit "key"');
  // Role keys must be unique across all teams; prefix with the team when the title is generic.
  const lead = leads[0];

  const reviewerOf = new Map<string, string>(); // producer key → reviewer key
  for (const r of spec.roles) for (const t of r.reviews) {
    const target = byTitle.get(t.toLowerCase());
    if (!target) { errors.push(`"${r.title}" reviews "${t}", which is not a role in this team`); continue; }
    if (target === r) { errors.push(`"${r.title}" cannot review itself`); continue; }
    reviewerOf.set(keyFor(target), keyFor(r));
  }
  if (errors.length) return { errors, notes };

  const roles: Role[] = spec.roles.map((r) => {
    const key = keyFor(r);
    const isReviewer = r.reviews.length > 0;
    const category: Role['category'] = r.lead ? 'manager' : isReviewer ? 'reviewer' : r.qa ? 'qa' : 'specialist';
    const capTools = r.works_with.flatMap((cap) => [...CAPABILITIES[cap].tools]);
    let tools: string[];
    if (category === 'reviewer') tools = [...REVIEWER, ...capTools.filter((t) => TOOLS_BY_NAME.get(t)?.actionClass === 'A0')];
    else if (category === 'manager') tools = [...BASE, ...MANAGER, ...capTools];
    else tools = [...BASE, ...PRODUCER, ...capTools];
    tools = [...new Set(tools)];

    const traits = toolTraits(tools);
    if (traits.has('reads_untrusted') && traits.has('reads_private') && traits.has('external_comms'))
      notes.push(`"${r.title}" combines untrusted input, private data, and external communication (Rule of Two): every external action it takes will need human approval`);
    const profile: Role['rule_of_two_profile'] = category === 'reviewer' ? 'reviewer'
      : traits.has('reads_untrusted') && traits.has('external_comms') ? 'mixed'
      : traits.has('reads_untrusted') ? 'researcher'
      : traits.has('external_comms') ? 'communicator' : 'builder';

    const doesCode = r.works_with.includes('code');
    const doesResearch = r.works_with.includes('web_research');
    const doesExternal = tools.some((t) => EXTERNAL_ACTION_TOOLS.has(t));
    let kinds: TaskKind[];
    if (category === 'manager') kinds = ['planning', 'decision', 'discovery', ...(doesCode ? ['integration' as const] : [])];
    else if (category === 'reviewer') kinds = ['review'];
    else if (category === 'qa') kinds = ['implementation', 'review'];
    else kinds = [...(doesCode ? ['implementation', 'remediation'] as const : doesResearch ? ['research'] as const : ['implementation'] as const), ...(doesExternal ? ['operation' as const] : [])];

    // Acceptance criteria: deterministic anchors from deliverables, review, and human judgment.
    const criteria: CriterionTemplate[] = [];
    if (category !== 'reviewer' && category !== 'manager') {
      if (doesCode) criteria.push({ kind: 'test_suite', statement: 'All tests pass on the submitted commit', independence: 'platform', required: true, check: { type: 'command', run: '${test_command}', timeout_s: 600 } });
      for (const d of r.delivers) {
        if ('document' in d) {
          const sections = d.sections ?? ['Summary', 'Details', 'Open Questions'];
          criteria.push({ kind: 'deterministic', statement: `${d.document} has ${sections.join(', ')} sections with real content`, independence: 'platform', required: true, check: { type: 'markdown_sections', path: d.document, sections } });
          criteria.push({ kind: 'deterministic', statement: `${d.document} contains no placeholder text`, independence: 'platform', required: true, check: { type: 'no_placeholder_text', path: d.document } });
        } else if ('file' in d) {
          criteria.push({ kind: 'deterministic', statement: `${d.file} exists`, independence: 'platform', required: true, check: { type: 'file_exists', path: d.file } });
        } else {
          criteria.push({ kind: 'test_suite', statement: d.says ?? `\`${d.check}\` succeeds on the submitted work`, independence: 'platform', required: true, check: { type: 'command', run: d.check, timeout_s: 600 } });
        }
      }
      if (!doesCode && !r.delivers.length) {
        const doc = `${spec.team}/${key}.md`;
        notes.push(`"${r.title}" has no deliverables listed; defaulting to a document at ${doc}`);
        criteria.push({ kind: 'deterministic', statement: `${doc} has Summary, Details, Open Questions sections with real content`, independence: 'platform', required: true, check: { type: 'markdown_sections', path: doc, sections: ['Summary', 'Details', 'Open Questions'] } });
      }
      if (reviewerOf.has(key)) criteria.push({ kind: 'rubric_review', statement: 'The work satisfies the pinned requirements and is fit for purpose', independence: 'different_lineage_model', required: true });
      if (r.human_judges) criteria.push({ kind: 'human_judgment', statement: r.human_judges, independence: 'human', required: true });
      if (r.affects_people && !r.human_judges) criteria.push({ kind: 'human_judgment', statement: 'A responsible human reviews and decides anything that affects an individual', independence: 'human', required: true });
    }

    const perRun = r.budget_per_run_usd ?? (category === 'manager' ? 10 : category === 'reviewer' ? 5 : doesCode ? 20 : 6);
    const deliverText = r.delivers.map((d) => ('document' in d ? `the document ${d.document}${d.sections ? ` with sections: ${d.sections.join(', ')}` : ''}` : 'file' in d ? `the file ${d.file}` : `work that passes \`${d.check}\``)).join('; ');
    const prompt = [
      `You are the ${r.title} on the ${spec.name} team. ${r.does}`,
      category === 'manager' ? 'Plan work into tasks for your team with clear, checkable acceptance criteria, and submit plans with ledger.propose_plan. Ask the CEO when requirements are ambiguous.' : '',
      category === 'reviewer' ? 'You review independently: judge each criterion separately against the verbatim requirements and cite the exact location of every finding.' : '',
      deliverText ? `Your deliverables: ${deliverText}.` : '',
      r.instructions ?? '',
      'Never claim work is complete; independent verification decides. Escalate instead of guessing.',
    ].filter(Boolean).join(' ');

    const role: Role = {
      key, version: spec.version, title: r.title, category,
      charter: r.does, responsibilities: r.responsibilities ?? [r.does],
      capabilities_required: { structured_output: true, tool_calling: true, min_context_tokens: doesCode ? 128000 : 32000 },
      tools, denied_tools: [], task_kinds: kinds, can_manage: category === 'manager', decision_authority: [],
      rule_of_two_profile: profile,
      budget: { per_run: { max_steps: doesCode ? 150 : 60, max_cost_usd: perRun, max_wall_minutes: doesCode ? 120 : 45 }, per_day_usd: perRun * 8 },
      criteria_templates: criteria,
      ...(reviewerOf.has(key) ? { reviewer_role: reviewerOf.get(key)! } : {}),
      affects_individuals: r.affects_people,
      escalation_path: category === 'manager' || category === 'reviewer' || category === 'qa' ? ['ceo'] : ['manager', 'ceo'],
      prompt,
      ...(r.advanced as Partial<Role> | undefined ?? {}),
    };
    return role;
  });

  const leadKey = keyFor(lead!);
  const structure = spec.roles.map((r) => {
    const key = keyFor(r);
    let reportsTo = 'ceo';
    if (r.reports_to) {
      const target = byTitle.get(r.reports_to.toLowerCase());
      if (r.reports_to.toLowerCase() === 'ceo') reportsTo = 'ceo';
      else if (target) reportsTo = keyFor(target);
      else errors.push(`"${r.title}" reports to "${r.reports_to}", which is not a role in this team`);
    } else if (!r.lead && r.reviews.length === 0 && !r.qa) reportsTo = leadKey;
    return { role: key, count: r.count, reports_to: reportsTo };
  });

  const producers = roles.filter((r) => r.category === 'specialist' || r.category === 'qa');
  const stages = [
    { key: 'plan', description: `${lead!.title} proposes a plan`, owner_role: leadKey, task_kind: 'planning' as const, gate: 'ceo_approval' as const },
    ...producers.map((p) => ({
      key: p.key, description: `${p.title}: ${p.charter.slice(0, 80)}`, owner_role: p.key, task_kind: p.task_kinds[0]!,
      gate: (p.criteria_templates.some((c) => c.independence === 'human') ? 'human_acceptance' : p.reviewer_role ? 'independent_review' : 'none') as 'human_acceptance' | 'independent_review' | 'none',
    })),
  ];
  if ((risk === 'R2' || risk === 'R3') && !stages.some((s) => s.gate === 'human_acceptance'))
    stages.push({ key: 'accept', description: 'The CEO accepts the result', owner_role: leadKey, task_kind: 'decision', gate: 'human_acceptance' });
  for (const p of producers) if (!p.reviewer_role && !p.criteria_templates.some((c) => c.independence === 'human'))
    notes.push(`"${p.title}" has no reviewer and no human judge; only deterministic checks will verify its work`);

  const department: Department = {
    key: spec.team, version: spec.version, name: spec.name, purpose: spec.purpose,
    default_mode: mode!, risk_floor: risk!, head: leadKey, roles, structure,
    workflows: [{ key: `${spec.team}_delivery`, name: `${spec.name} delivery`, stages }],
    kpis: spec.kpis ?? ['Verified completion rate', 'Rework rate (claims contradicted by evidence)', 'Cost per verified deliverable'],
    never_autonomous: spec.never_autonomous,
  };
  const final = DepartmentSchema.safeParse(department);
  if (!final.success) return { errors: [...errors, ...final.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)], notes };
  return { department: final.data, errors, notes };
}

/** A starter spec for `aic teams new`. */
export function starterSpec(team: string, name: string): string {
  return `# ${name} — a custom team. Define the roles; the platform derives the rest.
# Check it:  aic teams check ${team}      Hire it:  aic hire ${team}
team: ${team}
name: ${name}
purpose: >
  Describe in a sentence or two what this team is for and what good output looks like.
mode: plan_gates        # autonomous | exceptions | milestones | plan_gates | supervised
risk: standard          # low | standard | high | critical

roles:
  - title: ${name} Lead
    lead: true
    does: Turns CEO goals into a plan with clear, checkable deliverables and coordinates the team.

  - title: ${name} Specialist
    count: 2
    does: Produces the team's deliverables to the plan, with sources and open questions noted.
    works_with: [documents]         # code | documents | web_research | design_files | email_drafts | crm | tickets | analytics | ...
    delivers:
      - document: ${team}/DELIVERABLE.md
        sections: [Summary, Details, Open Questions]

  - title: ${name} Reviewer
    reviews: [${name} Specialist]
    does: Independently checks every deliverable against the original requirements and cites exact locations.

never_autonomous:
  - Anything sent outside the company
`;
}
