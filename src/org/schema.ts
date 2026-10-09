// Schemas for the team/employee architecture: roles and department templates.
// Templates are data (YAML) so customers can build custom departments without code.
import { z } from 'zod';
import { CRITERION_KINDS, MODES, RISK_TIERS, TASK_KINDS } from '../domain/types.js';

export const CapabilitiesSchema = z.object({
  structured_output: z.boolean().default(true),
  tool_calling: z.boolean().default(true),
  min_context_tokens: z.number().int().positive().default(32000),
});

/**
 * Deterministic checks the platform can run itself against a submitted artifact.
 * `${var}` placeholders are resolved from project settings (e.g. ${test_command}).
 */
export const CheckSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), run: z.string(), timeout_s: z.number().int().positive().default(600) }),
  z.object({ type: z.literal('file_exists'), path: z.string() }),
  z.object({ type: z.literal('markdown_sections'), path: z.string(), sections: z.array(z.string()).min(1) }),
  z.object({ type: z.literal('no_placeholder_text'), path: z.string() }),
]);
export type Check = z.infer<typeof CheckSchema>;

export const CriterionTemplateSchema = z.object({
  kind: z.enum(CRITERION_KINDS),
  statement: z.string().min(5),
  independence: z.enum(['platform', 'different_lineage_model', 'human', 'external_system']),
  required: z.boolean().default(true),
  check: CheckSchema.optional(),
});
export type CriterionTemplate = z.infer<typeof CriterionTemplateSchema>;

export const RoleSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  version: z.number().int().positive(),
  title: z.string(),
  category: z.enum(['executive', 'manager', 'specialist', 'reviewer', 'qa']),
  charter: z.string().min(20),
  responsibilities: z.array(z.string()).min(1),
  capabilities_required: CapabilitiesSchema.default({}),
  tools: z.array(z.string()).min(1),
  denied_tools: z.array(z.string()).default([]),
  task_kinds: z.array(z.enum(TASK_KINDS)).min(1),
  can_manage: z.boolean().default(false),
  /** Which decisions this role may make without escalating. */
  decision_authority: z.array(z.string()).default([]),
  rule_of_two_profile: z.enum(['researcher', 'builder', 'communicator', 'reviewer', 'mixed']),
  budget: z.object({
    per_run: z.object({
      max_steps: z.number().int().positive(),
      max_cost_usd: z.number().positive(),
      max_wall_minutes: z.number().int().positive(),
    }),
    per_day_usd: z.number().positive(),
  }),
  /** Criteria every task of this role starts with (managers may add more). */
  criteria_templates: z.array(CriterionTemplateSchema).default([]),
  /** Set when the role's output is inherently judged by humans (e.g. visual design taste). */
  human_verified_only: z.object({ reason: z.string() }).optional(),
  reviewer_role: z.string().optional(),
  /** Tasks flagged as significantly affecting individuals are forced to R3 (GDPR Art. 22). */
  affects_individuals: z.boolean().default(false),
  escalation_path: z.array(z.enum(['manager', 'department_head', 'ceo'])).min(1),
  prompt: z.string().min(20),
});
export type Role = z.infer<typeof RoleSchema>;

export const SeatSchema = z.object({
  role: z.string(),
  count: z.number().int().min(1).max(10).default(1),
  /** 'ceo' or another role key in the same department (the first seat of that role). */
  reports_to: z.string(),
});

export const WorkflowStageSchema = z.object({
  key: z.string(),
  description: z.string(),
  owner_role: z.string(),
  task_kind: z.enum(TASK_KINDS),
  gate: z.enum(['none', 'manager_review', 'independent_review', 'ceo_approval', 'human_acceptance']),
});

export const DepartmentSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  version: z.number().int().positive(),
  name: z.string(),
  purpose: z.string().min(20),
  default_mode: z.enum(MODES),
  risk_floor: z.enum(RISK_TIERS),
  head: z.string(),
  roles: z.array(RoleSchema).min(2),
  structure: z.array(SeatSchema).min(2),
  workflows: z.array(z.object({ key: z.string(), name: z.string(), stages: z.array(WorkflowStageSchema).min(2) })).min(1),
  kpis: z.array(z.string()).min(1),
  never_autonomous: z.array(z.string()).default([]),
});
export type Department = z.infer<typeof DepartmentSchema>;
