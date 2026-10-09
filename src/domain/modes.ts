// Operating modes as policy inputs — architecture.md §12.5.
import type { ActionClass, Mode, RiskTier } from './types.js';
import { modeRank, riskRank } from './types.js';

export type Gate = 'allow' | 'manager' | 'human' | 'blocked';

/** Most restrictive mode among the applicable scopes (org → project → objective). */
export function effectiveMode(...modes: (Mode | undefined)[]): Mode {
  return modes.filter((m): m is Mode => !!m).reduce<Mode>((a, b) => (modeRank(b) > modeRank(a) ? b : a), 'M1');
}

export interface GateInput {
  mode: Mode;
  actionClass: ActionClass;
  riskTier: RiskTier;
  /** A2 actions outside an approved plan (new plan or significant change). */
  planChange?: boolean;
  standingApproval?: boolean;
  /** Customer-flagged connector actions that always need a human. */
  alwaysHuman?: boolean;
}

/** Mode × action matrix (§12.5.3) plus floors no mode can lower. */
export function gateFor(i: GateInput): Gate {
  if (i.mode === 'M6') return i.actionClass === 'A0' ? 'allow' : i.actionClass === 'A6' ? 'human' : 'blocked';
  // Floors: governance, R3, and customer-flagged actions always need a human.
  if (i.actionClass === 'A6' || i.alwaysHuman) return 'human';
  // R3 work needs a human before any external side effect (A4/A5).
  if (i.riskTier === 'R3' && (i.actionClass === 'A4' || i.actionClass === 'A5')) return 'human';
  switch (i.actionClass) {
    case 'A0':
    case 'A1':
      return 'allow';
    case 'A2':
      if (i.mode === 'M5') return 'human';
      if (i.planChange) return i.mode === 'M4' ? 'human' : 'manager';
      return 'allow';
    case 'A3':
      return i.mode === 'M1' || i.mode === 'M3' ? 'manager' : 'human';
    case 'A4':
      return i.mode === 'M5' ? 'human' : 'allow';
    case 'A5':
      return i.mode === 'M1' && i.standingApproval && riskRank(i.riskTier) < riskRank('R3') ? 'allow' : 'human';
  }
}

/** Whether execution (dispatching runs) is permitted at all in this mode. */
export const modeAllowsExecution = (m: Mode) => m !== 'M6';

/** Whether a plan must be approved by a human before execution. */
export const planApprovalRequired = (m: Mode, riskTier: RiskTier) =>
  m === 'M4' || m === 'M5' || riskRank(riskTier) >= riskRank('R3');

/** Whether acceptance of a task at this tier needs a human, absent a standing acceptance. */
export const humanAcceptanceRequired = (riskTier: RiskTier, standingAcceptance = false) =>
  riskRank(riskTier) >= riskRank('R3') || (riskRank(riskTier) >= riskRank('R2') && !standingAcceptance);
