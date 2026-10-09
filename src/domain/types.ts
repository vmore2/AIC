// Core vocabulary shared by every layer. See architecture.md §8 and Appendix B.

export const TASK_STATUSES = [
  'draft', 'awaiting_plan_approval', 'planned', 'ready', 'in_progress', 'awaiting_input',
  'submitted', 'verifying', 'in_review', 'awaiting_acceptance', 'accepted',
  'changes_requested', 'uncertain', 'failed', 'cancelled', 'superseded',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['cancelled', 'superseded']);
/** States in which work is owned by the system rather than a person or employee. */
export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'ready', 'in_progress', 'awaiting_input', 'submitted', 'verifying', 'in_review', 'awaiting_acceptance', 'changes_requested', 'uncertain',
]);

export const TASK_KINDS = [
  'discovery', 'planning', 'implementation', 'integration', 'review', 'research', 'decision', 'remediation', 'operation',
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const RISK_TIERS = ['R0', 'R1', 'R2', 'R3'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];
export const riskRank = (r: RiskTier): number => RISK_TIERS.indexOf(r);
export const maxRisk = (...rs: RiskTier[]): RiskTier =>
  rs.reduce((a, b) => (riskRank(b) > riskRank(a) ? b : a), 'R0' as RiskTier);

/** Action risk classes (§12.5.1). */
export const ACTION_CLASSES = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** Operating modes (§12.5.2). */
export const MODES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'] as const;
export type Mode = (typeof MODES)[number];
export const MODE_NAMES: Record<Mode, string> = {
  M1: 'Autonomous', M2: 'Exception Escalation', M3: 'Milestone Gates',
  M4: 'Plan Gates', M5: 'Supervised', M6: 'Safe Mode',
};
/** Higher rank = more restrictive. The most restrictive applicable scope wins. */
export const modeRank = (m: Mode): number => MODES.indexOf(m);

export const HOLDS = ['mode_pause', 'e_stop', 'budget_hold', 'approval_withdrawn', 'dependency_regressed', 'security_hold'] as const;
export type Hold = (typeof HOLDS)[number];

export const CRITERION_KINDS = [
  'deterministic', 'test_suite', 'schema', 'rubric_review', 'human_judgment', 'external_reconciliation', 'metric_threshold',
] as const;
export type CriterionKind = (typeof CRITERION_KINDS)[number];

export const INDEPENDENCE_CLASSES = [
  'platform_deterministic', 'sandboxed_runner', 'different_lineage_model', 'same_lineage_model', 'human', 'external_system',
] as const;
export type IndependenceClass = (typeof INDEPENDENCE_CLASSES)[number];

export type PrincipalType = 'user' | 'employee' | 'system';
export interface Principal {
  type: PrincipalType;
  id: string;
  /** Users: their org role. Employees: their role key. */
  role?: string;
  /** Employees acting inside a run carry the run and its lease epoch (INV-7). */
  runId?: string;
  epoch?: number;
  /** Users: whether the session has fresh step-up authentication (MFA). */
  stepUp?: boolean;
}

export const SYSTEM: Principal = { type: 'system', id: 'system' };
