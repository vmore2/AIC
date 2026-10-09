// Completion Evaluator — architecture.md §8.5.4.
// A PURE, deterministic function. It never calls a model and never reads a worker's claims.

import type { CriterionKind, IndependenceClass, RiskTier } from './types.js';
import { riskRank } from './types.js';

export type RequiredIndependence = 'platform' | 'different_lineage_model' | 'human' | 'external_system';

export interface CriterionSpec {
  id: string;
  statement: string;
  kind: CriterionKind;
  required: boolean;
  independence: RequiredIndependence;
}

export interface EvidenceRecord {
  id: string;
  criterionId: string;
  /** Artifact version ids this evidence was produced against (INV-3). */
  artifactVersionIds: string[];
  verifierId: string;
  independence: IndependenceClass;
  /** For model reviewers: whether the reviewer's model family differs from every producer's family. */
  familyDiffers?: boolean;
  result: 'pass' | 'fail' | 'inconclusive' | 'error';
  /** False for heuristic / flaky signals (e.g. a single model reviewer's fail). */
  definitive: boolean;
}

export interface ActionState { id: string; requiredForAcceptance: boolean; status: string }

export interface EvaluationInput {
  criteria: CriterionSpec[];
  evidence: EvidenceRecord[];
  submittedArtifactVersionIds: string[];
  /** Every principal (employees, runs) in the producing lineage (INV-2). */
  producerLineage: ReadonlySet<string>;
  riskTier: RiskTier;
  actions: ActionState[];
}

export type CriterionStatus = 'satisfied' | 'failed' | 'pending' | 'inconclusive';

export type EvaluationOutcome =
  | 'changes_requested'   // a required criterion definitively failed
  | 'uncertain'           // inconclusive evidence or unresolved external actions
  | 'pending'             // still waiting on automated evidence
  | 'awaiting_review'     // deterministic criteria satisfied; independent review outstanding
  | 'awaiting_human'      // everything non-human satisfied; a human must accept
  | 'satisfied';          // every required criterion satisfied by eligible evidence

export interface EvaluationResult {
  outcome: EvaluationOutcome;
  criteria: { id: string; status: CriterionStatus; eligibleEvidence: string[]; excludedEvidence: { id: string; reason: string }[] }[];
  blockingActions: string[];
}

const STRONG: ReadonlySet<IndependenceClass> = new Set(['platform_deterministic', 'sandboxed_runner', 'external_system', 'human']);

/** Does this evidence meet the independence the criterion demands at this risk tier? */
export function meetsIndependence(e: EvidenceRecord, required: RequiredIndependence, tier: RiskTier): boolean {
  switch (required) {
    case 'platform':
      return STRONG.has(e.independence);
    case 'external_system':
      return e.independence === 'external_system' || e.independence === 'human';
    case 'human':
      return e.independence === 'human';
    case 'different_lineage_model':
      if (e.independence === 'human') return true;
      if (e.independence !== 'different_lineage_model') return false;
      // R2+ rubric judgments need a different model family, because same-family models share failure modes.
      return riskRank(tier) < riskRank('R2') || e.familyDiffers === true;
  }
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

export function evaluateCompletion(input: EvaluationInput): EvaluationResult {
  const perCriterion = input.criteria.map((c) => {
    const excluded: { id: string; reason: string }[] = [];
    const eligible = input.evidence.filter((e) => {
      if (e.criterionId !== c.id) return false;
      if (!sameSet(e.artifactVersionIds, input.submittedArtifactVersionIds)) { excluded.push({ id: e.id, reason: 'artifact_mismatch' }); return false; }
      if (input.producerLineage.has(e.verifierId)) { excluded.push({ id: e.id, reason: 'producer_lineage' }); return false; }
      if (e.independence === 'same_lineage_model') { excluded.push({ id: e.id, reason: 'same_lineage_model' }); return false; }
      if (!meetsIndependence(e, c.independence, input.riskTier)) { excluded.push({ id: e.id, reason: 'insufficient_independence' }); return false; }
      return true;
    });
    let status: CriterionStatus;
    const definitiveFail = eligible.some((e) => e.result === 'fail' && e.definitive);
    const passes = eligible.filter((e) => e.result === 'pass');
    const softFail = eligible.some((e) => e.result === 'fail' && !e.definitive);
    if (definitiveFail) status = 'failed';
    else if (passes.length > 0) status = softFail ? 'inconclusive' : 'satisfied';
    else if (softFail || eligible.some((e) => e.result === 'inconclusive' || e.result === 'error')) status = 'inconclusive';
    else status = 'pending';
    return { c, status, eligibleEvidence: eligible.map((e) => e.id), excludedEvidence: excluded };
  });

  const required = perCriterion.filter((p) => p.c.required);
  const blockingActions = input.actions
    .filter((a) => a.requiredForAcceptance && ['intended', 'attempting', 'unknown', 'uncertain'].includes(a.status))
    .map((a) => a.id);

  let outcome: EvaluationOutcome;
  const isHuman = (p: (typeof required)[number]) => p.c.kind === 'human_judgment' || p.c.independence === 'human';
  const isReview = (p: (typeof required)[number]) => p.c.kind === 'rubric_review';
  if (required.some((p) => p.status === 'failed')) outcome = 'changes_requested';
  else if (required.some((p) => p.status === 'inconclusive') || blockingActions.length > 0) outcome = 'uncertain';
  else if (required.some((p) => p.status === 'pending' && !isHuman(p) && !isReview(p))) outcome = 'pending';
  else if (required.some((p) => p.status === 'pending' && isReview(p))) outcome = 'awaiting_review';
  else if (required.some((p) => p.status === 'pending' && isHuman(p))) outcome = 'awaiting_human';
  else outcome = 'satisfied';

  return {
    outcome,
    blockingActions,
    criteria: perCriterion.map((p) => ({ id: p.c.id, status: p.status, eligibleEvidence: p.eligibleEvidence, excludedEvidence: p.excludedEvidence })),
  };
}

/** Assurance label (§11.8) derived from the evidence that satisfied the criteria. */
export function assuranceLabel(input: EvaluationInput, result: EvaluationResult, acceptedFromUncertain = false): string {
  if (acceptedFromUncertain) return 'A-qualified';
  const used = new Set(result.criteria.flatMap((c) => c.eligibleEvidence));
  const classes = new Set(input.evidence.filter((e) => used.has(e.id) && e.result === 'pass').map((e) => e.independence));
  const det = classes.has('platform_deterministic') || classes.has('sandboxed_runner') || classes.has('external_system');
  const rev = classes.has('different_lineage_model');
  const human = classes.has('human');
  if (!det && human) return 'A-human-only';
  return ['A-det', rev ? '+rev' : '', human ? '+human' : ''].join('');
}
