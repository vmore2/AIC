import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { decide, REQUESTERS, type GuardFacts, type TaskView, type TransitionType } from '../src/domain/stateMachine.js';
import { evaluateCompletion, type CriterionSpec, type EvidenceRecord } from '../src/domain/completion.js';
import { checkAttenuation, wouldCreateCycle } from '../src/domain/delegation.js';
import { effectiveMode, gateFor } from '../src/domain/modes.js';
import { HOLDS, RISK_TIERS, TASK_KINDS, TASK_STATUSES, type PrincipalType } from '../src/domain/types.js';
import { canonicalJson, chainHash, GENESIS_HASH } from '../src/domain/hash.js';

const baseTask: TaskView = {
  status: 'in_progress', kind: 'implementation', riskTier: 'R1', hold: null, criteriaFrozen: true,
  attempt: 1, maxAttempts: 3, ownerId: 'emp_a', managerId: 'emp_lead', leaseEpoch: 4,
};

describe('state machine guards', () => {
  it('rejects SubmitWork from a stale lease epoch (INV-7)', () => {
    const d = decide(baseTask, 'SubmitWork', { requesterType: 'employee', requesterId: 'emp_a', requesterEpoch: 3, hasArtifacts: true });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.unmet).toContain('lease_epoch_current');
  });

  it('accepts SubmitWork from the owner with the current epoch, landing in submitted (a claim, not completion)', () => {
    const d = decide(baseTask, 'SubmitWork', { requesterType: 'employee', requesterId: 'emp_a', requesterEpoch: 4, hasArtifacts: true });
    expect(d).toMatchObject({ ok: true, to: 'submitted' });
  });

  it('refuses dispatch without frozen criteria unless the task is discovery (INV-4)', () => {
    const t = { ...baseTask, status: 'ready' as const, criteriaFrozen: false };
    const facts: GuardFacts = { requesterType: 'system', requesterId: 'system', ownerActive: true, budgetAvailable: true, modeAllowsExecution: true };
    expect(decide(t, 'Dispatch', facts).ok).toBe(false);
    expect(decide({ ...t, kind: 'discovery' }, 'Dispatch', facts).ok).toBe(true);
  });

  it('never accepts while a hold is present', () => {
    const t = { ...baseTask, status: 'verifying' as const, hold: 'e_stop' as const };
    const d = decide(t, 'ApplyEvaluation', { requesterType: 'system', requesterId: 'system', evaluation: 'satisfied', humanAcceptanceRequired: false });
    expect(d.ok).toBe(false);
  });

  it('routes satisfied R2 work to human acceptance instead of accepted', () => {
    const t = { ...baseTask, status: 'verifying' as const, riskTier: 'R2' as const };
    expect(decide(t, 'ApplyEvaluation', { requesterType: 'system', requesterId: 'system', evaluation: 'satisfied', humanAcceptanceRequired: true }))
      .toMatchObject({ ok: true, to: 'awaiting_acceptance' });
  });

  it('blocks a human approver who is in the producer lineage (INV-2)', () => {
    const t = { ...baseTask, status: 'awaiting_acceptance' as const };
    const d = decide(t, 'AcceptTask', { requesterType: 'user', requesterId: 'u1', approvalValid: true, requesterInProducerLineage: true });
    expect(d.ok).toBe(false);
  });

  // Property: across arbitrary commands, facts, and requesters, no employee or system request
  // can ever move a task directly into `accepted` except via ApplyEvaluation on satisfied evidence,
  // and employees can never cause `accepted` at all.
  const statusArb = fc.constantFrom(...TASK_STATUSES);
  const typeArb = fc.constantFrom(...(Object.keys(REQUESTERS) as TransitionType[]));
  const requesterArb = fc.constantFrom<PrincipalType>('user', 'employee', 'system');
  const factsArb = fc.record({
    requesterEpoch: fc.option(fc.integer({ min: 0, max: 6 }), { nil: undefined }),
    depsSatisfied: fc.boolean(), planApprovalRequired: fc.boolean(), approvalValid: fc.boolean(), criteriaComplete: fc.boolean(),
    ownerActive: fc.boolean(), budgetAvailable: fc.boolean(), modeAllowsExecution: fc.boolean(), hasArtifacts: fc.boolean(),
    openAttemptingActions: fc.integer({ min: 0, max: 2 }),
    evaluation: fc.constantFrom('changes_requested', 'uncertain', 'pending', 'awaiting_review', 'awaiting_human', 'satisfied', undefined),
    humanAcceptanceRequired: fc.boolean(), requesterInProducerLineage: fc.boolean(), requesterManagesTask: fc.boolean(),
    rationale: fc.option(fc.string(), { nil: undefined }), budgetExhausted: fc.boolean(),
  });
  const taskArb = fc.record({
    status: statusArb, kind: fc.constantFrom(...TASK_KINDS), riskTier: fc.constantFrom(...RISK_TIERS),
    hold: fc.option(fc.constantFrom(...HOLDS), { nil: null }), criteriaFrozen: fc.boolean(),
    attempt: fc.integer({ min: 0, max: 4 }), maxAttempts: fc.integer({ min: 1, max: 4 }),
    ownerId: fc.option(fc.constant('emp_a'), { nil: null }), managerId: fc.constant('emp_lead'), leaseEpoch: fc.integer({ min: 0, max: 6 }),
  });

  it('property: employees never cause acceptance; acceptance always comes from evidence or a human', () => {
    fc.assert(fc.property(taskArb, typeArb, requesterArb, factsArb, (task, type, rt, facts) => {
      const d = decide(task, type, { ...facts, requesterType: rt, requesterId: rt === 'employee' ? 'emp_a' : 'x' } as GuardFacts);
      if (!d.ok || d.to !== 'accepted' || task.status === 'accepted') return true;
      if (rt === 'employee') return false;
      if (type === 'ApplyEvaluation') return facts.evaluation === 'satisfied' && !facts.humanAcceptanceRequired && task.hold === null;
      if (type === 'AcceptTask' || type === 'AcceptUncertain') return rt === 'user' && !facts.requesterInProducerLineage && task.hold === null;
      return false;
    }), { numRuns: 20000 });
  });

  it('property: nothing enters in_progress without frozen criteria (except discovery) or while held', () => {
    fc.assert(fc.property(taskArb, typeArb, requesterArb, factsArb, (task, type, rt, facts) => {
      const d = decide(task, type, { ...facts, requesterType: rt, requesterId: 'x' } as GuardFacts);
      if (!d.ok || d.to !== 'in_progress' || task.status === 'in_progress') return true;
      return (task.criteriaFrozen || task.kind === 'discovery') && task.hold === null;
    }), { numRuns: 20000 });
  });

  it('property: terminal states never transition', () => {
    fc.assert(fc.property(taskArb, typeArb, requesterArb, factsArb, (task, type, rt, facts) => {
      if (task.status !== 'cancelled' && task.status !== 'superseded') return true;
      return !decide(task, type, { ...facts, requesterType: rt, requesterId: 'x' } as GuardFacts).ok;
    }), { numRuns: 5000 });
  });
});

describe('completion evaluator', () => {
  const criteria: CriterionSpec[] = [
    { id: 'ac1', statement: 'tests pass', kind: 'test_suite', required: true, independence: 'platform' },
    { id: 'ac2', statement: 'review', kind: 'rubric_review', required: true, independence: 'different_lineage_model' },
  ];
  const ev = (o: Partial<EvidenceRecord>): EvidenceRecord => ({
    id: Math.random().toString(36), criterionId: 'ac1', artifactVersionIds: ['av1'], verifierId: 'svc_runner',
    independence: 'sandboxed_runner', result: 'pass', definitive: true, ...o,
  });
  const base = { criteria, submittedArtifactVersionIds: ['av1'], producerLineage: new Set(['emp_a', 'run_1']), riskTier: 'R1' as const, actions: [] };

  it('ignores evidence produced by the producer lineage (INV-2)', () => {
    const r = evaluateCompletion({ ...base, evidence: [ev({ verifierId: 'emp_a' }), ev({ criterionId: 'ac2', verifierId: 'run_1', independence: 'different_lineage_model' })] });
    expect(r.outcome).toBe('pending');
    expect(r.criteria[0]!.excludedEvidence[0]!.reason).toBe('producer_lineage');
  });

  it('ignores evidence about a different artifact version (INV-3)', () => {
    const r = evaluateCompletion({ ...base, evidence: [ev({ artifactVersionIds: ['av0'] })] });
    expect(r.criteria[0]!.status).toBe('pending');
  });

  it('a definitive failure requests changes', () => {
    expect(evaluateCompletion({ ...base, evidence: [ev({ result: 'fail' })] }).outcome).toBe('changes_requested');
  });

  it('deterministic pass + pending review => awaiting_review; then satisfied with independent review', () => {
    expect(evaluateCompletion({ ...base, evidence: [ev({})] }).outcome).toBe('awaiting_review');
    const r = evaluateCompletion({ ...base, evidence: [ev({}), ev({ criterionId: 'ac2', verifierId: 'emp_rev', independence: 'different_lineage_model' })] });
    expect(r.outcome).toBe('satisfied');
  });

  it('R2 review from the same model family does not count', () => {
    const r = evaluateCompletion({ ...base, riskTier: 'R2', evidence: [ev({}), ev({ criterionId: 'ac2', verifierId: 'emp_rev', independence: 'different_lineage_model', familyDiffers: false })] });
    expect(r.outcome).toBe('awaiting_review');
  });

  it('unresolved external actions make the outcome uncertain (INV-11)', () => {
    const r = evaluateCompletion({ ...base, evidence: [ev({}), ev({ criterionId: 'ac2', verifierId: 'emp_rev', independence: 'different_lineage_model' })],
      actions: [{ id: 'act1', requiredForAcceptance: true, status: 'unknown' }] });
    expect(r.outcome).toBe('uncertain');
  });
});

describe('delegation, modes, hashing', () => {
  it('attenuation rejects widened tools, budget, and autonomy (INV-13)', () => {
    const unmet = checkAttenuation(
      { toolGrants: ['repo.read', 'sandbox.exec'], budgetRemaining: 10, autonomyCeiling: 'M4', riskFloor: 'R1', deadline: '2026-12-01', depth: 1 },
      ['repo.read', 'sandbox.exec', 'repo.merge'],
      { toolGrants: ['repo.read', 'repo.merge'], budget: 20, autonomyCeiling: 'M1', riskTier: 'R0', deadline: '2027-01-01' },
      { maxDepth: 4, maxChildren: 12, currentChildren: 0 });
    expect(unmet).toEqual(expect.arrayContaining([
      'tool_grants_exceed_parent(repo.merge)', 'budget_exceeds_parent_remaining', 'autonomy_exceeds_parent', 'risk_below_parent_floor', 'deadline_after_parent']));
  });

  it('detects dependency cycles', () => {
    const edges = [{ taskId: 'b', dependsOn: 'a' }, { taskId: 'c', dependsOn: 'b' }];
    expect(wouldCreateCycle(edges, 'a', 'c')).toBe(true);
    expect(wouldCreateCycle(edges, 'd', 'c')).toBe(false);
  });

  it('modes: most restrictive wins; floors hold in Autonomous', () => {
    expect(effectiveMode('M1', 'M4', undefined)).toBe('M4');
    expect(gateFor({ mode: 'M1', actionClass: 'A5', riskTier: 'R1' })).toBe('human');
    expect(gateFor({ mode: 'M1', actionClass: 'A5', riskTier: 'R1', standingApproval: true })).toBe('allow');
    expect(gateFor({ mode: 'M1', actionClass: 'A5', riskTier: 'R3', standingApproval: true })).toBe('human');
    expect(gateFor({ mode: 'M1', actionClass: 'A6', riskTier: 'R0' })).toBe('human');
    expect(gateFor({ mode: 'M6', actionClass: 'A1', riskTier: 'R0' })).toBe('blocked');
  });

  it('hash chain is order-sensitive and canonical', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    const h1 = chainHash(GENESIS_HASH, { x: 1 });
    expect(chainHash(h1, { y: 2 })).not.toBe(chainHash(chainHash(GENESIS_HASH, { y: 2 }), { x: 1 }));
  });
});
