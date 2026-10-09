// Task state machine — architecture.md §8.2 / §8.4 (transition table T1–T24).
// Pure guard logic: given a task view, a transition command, the requesting principal,
// and facts gathered from the ledger, decide the target state or list the unmet guards.

import type { EvaluationOutcome } from './completion.js';
import type { Hold, PrincipalType, RiskTier, TaskKind, TaskStatus } from './types.js';
import { riskRank, TERMINAL_STATUSES } from './types.js';

export interface TaskView {
  status: TaskStatus;
  kind: TaskKind;
  riskTier: RiskTier;
  hold: Hold | null;
  criteriaFrozen: boolean;
  attempt: number;
  maxAttempts: number;
  ownerId: string | null;
  managerId: string | null;
  leaseEpoch: number;
}

/** Facts gathered by the Transition Engine from the ledger (never from agent claims). */
export interface GuardFacts {
  requesterType: PrincipalType;
  requesterId: string;
  requesterEpoch?: number;
  depsSatisfied?: boolean;
  planApprovalRequired?: boolean;
  approvalValid?: boolean;
  criteriaComplete?: boolean;
  ownerActive?: boolean;
  budgetAvailable?: boolean;
  modeAllowsExecution?: boolean;
  hasArtifacts?: boolean;
  openAttemptingActions?: number;
  evaluation?: EvaluationOutcome;
  humanAcceptanceRequired?: boolean;
  requesterInProducerLineage?: boolean;
  requesterManagesTask?: boolean;
  rationale?: string;
  budgetExhausted?: boolean;
}

export type TransitionType =
  | 'SubmitForApproval' | 'PlanTask' | 'ApprovePlan' | 'RejectPlan' | 'MarkReady' | 'Dispatch'
  | 'RaiseBlocker' | 'ResolveBlocker' | 'SubmitWork' | 'RecordRunFailed' | 'RecordRunAbandoned'
  | 'StartVerification' | 'ApplyEvaluation' | 'AcceptTask' | 'RejectTask' | 'AcceptUncertain'
  | 'RequeueAfterChanges' | 'ReopenTask' | 'RetryTask' | 'CancelTask' | 'SupersedeTask';

export type Decision =
  | { ok: true; to: TaskStatus; effects: Effect[] }
  | { ok: false; unmet: string[] };

export type Effect =
  | 'freeze_criteria' | 'grant_lease' | 'revoke_lease' | 'suspend_lease' | 'increment_attempt'
  | 'reset_attempts' | 'release_budget' | 'mark_downstream_suspect' | 'unblock_dependents';

/** Who may request each transition (defense in depth beside the policy engine). */
export const REQUESTERS: Record<TransitionType, PrincipalType[]> = {
  SubmitForApproval: ['user', 'employee'],
  PlanTask: ['user', 'employee', 'system'],
  ApprovePlan: ['user'],
  RejectPlan: ['user'],
  MarkReady: ['system'],
  Dispatch: ['system'],
  RaiseBlocker: ['employee'],
  ResolveBlocker: ['user', 'employee'],
  SubmitWork: ['employee'],
  RecordRunFailed: ['system'],
  RecordRunAbandoned: ['system'],
  StartVerification: ['system'],
  ApplyEvaluation: ['system'],
  AcceptTask: ['user'],
  RejectTask: ['user'],
  AcceptUncertain: ['user'],
  RequeueAfterChanges: ['system'],
  ReopenTask: ['user', 'system'],
  RetryTask: ['user'],
  CancelTask: ['user', 'employee'],
  SupersedeTask: ['system'],
};

const NON_TERMINAL = (s: TaskStatus) => !TERMINAL_STATUSES.has(s);

export function decide(task: TaskView, type: TransitionType, f: GuardFacts): Decision {
  const unmet: string[] = [];
  const need = (cond: boolean | undefined, name: string) => { if (!cond) unmet.push(name); };
  const from = (...states: TaskStatus[]) => need(states.includes(task.status), `status_in(${states.join('|')})`);

  need(REQUESTERS[type].includes(f.requesterType), `requester_type_allowed(${f.requesterType})`);

  const epochCurrent = f.requesterEpoch !== undefined && f.requesterEpoch === task.leaseEpoch;
  let to: TaskStatus = task.status;
  const effects: Effect[] = [];

  switch (type) {
    case 'SubmitForApproval':
      from('draft'); need(f.criteriaComplete, 'criteria_complete'); need(task.ownerId !== null, 'owner_assigned');
      to = 'awaiting_plan_approval';
      break;
    case 'PlanTask':
      from('draft'); need(f.criteriaComplete, 'criteria_complete'); need(task.ownerId !== null, 'owner_assigned');
      need(f.planApprovalRequired === false, 'plan_approval_not_required');
      to = 'planned'; effects.push('freeze_criteria');
      break;
    case 'ApprovePlan':
      from('awaiting_plan_approval'); need(f.approvalValid, 'approval_bound_and_valid');
      to = 'planned'; effects.push('freeze_criteria');
      break;
    case 'RejectPlan':
      from('awaiting_plan_approval'); need(!!f.rationale, 'rationale_present');
      to = 'draft';
      break;
    case 'MarkReady':
      from('planned'); need(f.depsSatisfied, 'dependencies_accepted'); need(task.hold === null, 'no_hold');
      to = 'ready';
      break;
    case 'Dispatch':
      from('ready'); need(task.hold === null, 'no_hold');
      need(task.criteriaFrozen || task.kind === 'discovery', 'criteria_frozen'); // INV-4
      need(task.ownerId !== null && !!f.ownerActive, 'owner_active');
      need(f.budgetAvailable, 'budget_reservable');
      need(f.modeAllowsExecution, 'mode_allows_execution');
      to = 'in_progress'; effects.push('grant_lease', 'increment_attempt');
      break;
    case 'RaiseBlocker':
      from('in_progress'); need(epochCurrent, 'lease_epoch_current');
      to = 'awaiting_input'; effects.push('suspend_lease');
      break;
    case 'ResolveBlocker':
      from('awaiting_input');
      need(f.requesterType === 'user' || !!f.requesterManagesTask, 'resolver_has_authority');
      to = 'ready'; effects.push('revoke_lease');
      break;
    case 'SubmitWork':
      from('in_progress'); need(epochCurrent, 'lease_epoch_current');
      need(f.requesterId === task.ownerId, 'requester_is_owner');
      need(f.hasArtifacts, 'artifacts_present');
      need((f.openAttemptingActions ?? 0) === 0, 'no_open_external_actions');
      to = 'submitted'; effects.push('revoke_lease');
      break;
    case 'RecordRunFailed':
    case 'RecordRunAbandoned': {
      from('in_progress', 'awaiting_input');
      const exhausted = task.attempt >= task.maxAttempts || !!f.budgetExhausted;
      to = exhausted ? 'failed' : 'ready'; effects.push('revoke_lease', 'release_budget');
      break;
    }
    case 'StartVerification':
      from('submitted');
      to = 'verifying';
      break;
    case 'ApplyEvaluation': {
      from('verifying', 'in_review');
      const ev = f.evaluation;
      need(ev !== undefined && ev !== 'pending', 'evaluation_conclusive');
      if (ev === 'changes_requested') to = 'changes_requested';
      else if (ev === 'uncertain') to = 'uncertain';
      else if (ev === 'awaiting_review') to = 'in_review';
      else if (ev === 'awaiting_human') to = 'awaiting_acceptance';
      else if (ev === 'satisfied') {
        if (f.humanAcceptanceRequired) to = 'awaiting_acceptance';
        else { need(task.hold === null, 'no_hold'); to = 'accepted'; effects.push('unblock_dependents'); }
      }
      if (to === task.status && unmet.length === 0) unmet.push('no_state_change');
      break;
    }
    case 'AcceptTask':
      from('awaiting_acceptance'); need(task.hold === null, 'no_hold');
      need(!f.requesterInProducerLineage, 'approver_not_in_producer_lineage'); // INV-2
      need(f.approvalValid, 'acceptance_bound_to_submission');
      to = 'accepted'; effects.push('unblock_dependents');
      break;
    case 'RejectTask':
      from('awaiting_acceptance'); need(!!f.rationale, 'rationale_present');
      to = 'changes_requested';
      break;
    case 'AcceptUncertain':
      from('uncertain'); need(task.hold === null, 'no_hold');
      need(riskRank(task.riskTier) <= riskRank('R2'), 'risk_tier_at_most_R2');
      need(!!f.rationale, 'rationale_present');
      need(!f.requesterInProducerLineage, 'approver_not_in_producer_lineage');
      to = 'accepted'; effects.push('unblock_dependents');
      break;
    case 'RequeueAfterChanges':
      from('changes_requested');
      to = task.attempt >= task.maxAttempts ? 'failed' : 'ready';
      break;
    case 'ReopenTask':
      from('accepted'); need(!!f.rationale, 'reason_present');
      to = 'ready'; effects.push('mark_downstream_suspect');
      break;
    case 'RetryTask':
      from('failed'); need(f.budgetAvailable, 'budget_reservable');
      to = 'ready'; effects.push('reset_attempts');
      break;
    case 'CancelTask':
      need(NON_TERMINAL(task.status) && task.status !== 'accepted', 'cancellable_state');
      need(f.requesterType === 'user' || !!f.requesterManagesTask, 'canceller_manages_task');
      to = 'cancelled'; effects.push('revoke_lease', 'release_budget');
      break;
    case 'SupersedeTask':
      need(['draft', 'planned', 'ready', 'in_progress', 'awaiting_input', 'changes_requested'].includes(task.status), 'supersedable_state');
      to = 'superseded'; effects.push('revoke_lease', 'release_budget');
      break;
  }

  return unmet.length ? { ok: false, unmet } : { ok: true, to, effects };
}
