import { afterEach, describe, expect, it } from 'vitest';
import { DomainError, verifyChain } from '../src/ledger/engine.js';
import { emp, setupCompany, SYSTEM } from './helpers.js';
import type { Ledger } from '../src/ledger/ledger.js';

let ledger: Ledger | undefined;
afterEach(async () => { await ledger?.close(); ledger = undefined; });

const plan = {
  summary: 'Implement the greeting module with tests and an independent QA suite.',
  tasks: [
    { ref: 'impl', title: 'Implement greet()', kind: 'implementation', spec: 'Implement greet(name) returning "Hello, <name>!" with unit tests.',
      owner_role: 'software_engineer', requirement_keys: ['REQ-1'], budget_usd: 5 },
    { ref: 'qa', title: 'Acceptance tests for greet()', kind: 'implementation', spec: 'Write acceptance tests for REQ-1 independent of the implementation.',
      owner_role: 'software_engineer', requirement_keys: ['REQ-1'], depends_on: [], budget_usd: 3 },
  ],
  risks: ['Name may contain unicode'],
};

async function objectiveWithPlanningRun() {
  const s = await setupCompany('M4');
  ledger = s.ledger;
  const obj = await s.ledger.run('createObjective', {
    title: 'Greeting feature', departmentKey: 'engineering', budgetUsd: 50,
    requirements: [{ key: 'REQ-1', text: 'greet(name) returns "Hello, <name>!"' }], settings: { test_command: 'npm test' },
  }, s.ceo);
  await s.ledger.run('markReady', { taskId: obj.planningTaskId }, SYSTEM);
  const d = await s.ledger.run('dispatchTask', { taskId: obj.planningTaskId }, SYSTEM);
  const lead = s.byRole('engineering_lead')[0]!;
  return { ...s, obj, d, lead };
}

async function errCode(p: Promise<unknown>) {
  try { await p; return 'ok'; } catch (e) { return e instanceof DomainError ? e.code : String(e); }
}

describe('ledger: plans from team leads', () => {
  it('lead proposes, platform validates, CEO approves, plan becomes frozen tasks', async () => {
    const s = await objectiveWithPlanningRun();
    expect(s.obj.planApprovalRequired).toBe(true);
    const { proposalId } = await s.ledger.run('proposePlan', { taskId: s.obj.planningTaskId, plan }, emp(s.lead, s.d.runId, s.d.epoch));

    // Verification: the platform plan validator (service) records evidence; the CE then needs the CEO.
    await s.ledger.run('startVerification', { taskId: s.obj.planningTaskId }, SYSTEM);
    const crit = (await s.ledger.db.query<{ id: string; independence: string }>(
      `SELECT cr.id, cr.independence FROM criteria cr JOIN tasks t ON t.criteria_set_id = cr.criteria_set_id WHERE t.id = $1 ORDER BY ordinal`, [s.obj.planningTaskId])).rows;
    const sub = (await s.ledger.db.query<{ id: string }>(`SELECT id FROM submissions WHERE task_id = $1 AND status='open'`, [s.obj.planningTaskId])).rows[0]!;
    await s.ledger.run('recordEvidence', { submissionId: sub.id, criterionId: crit[0]!.id, result: 'pass', details: {}, service: { id: 'svc_plan_validator', independence: 'platform_deterministic' } }, SYSTEM);
    const ev = await s.ledger.run('evaluateTask', { taskId: s.obj.planningTaskId }, SYSTEM);
    expect(ev).toEqual({ outcome: 'awaiting_human', status: 'awaiting_acceptance' });

    // The lead cannot approve its own plan.
    expect(await errCode(s.ledger.run('decideProposal', { proposalId, decision: 'approve' }, emp(s.lead, s.d.runId, s.d.epoch)))).toBe('forbidden');

    await s.ledger.run('decideProposal', { proposalId, decision: 'approve', rationale: 'Looks right' }, s.ceo);
    const { taskIds } = await s.ledger.run('materializePlan', { planningTaskId: s.obj.planningTaskId }, SYSTEM);
    expect(taskIds).toHaveLength(2);
    const rows = (await s.ledger.db.query<{ status: string; criteria_frozen_at: string | null; owner_employee_id: string }>(
      'SELECT status, criteria_frozen_at, owner_employee_id FROM tasks WHERE parent_task_id = $1', [s.obj.planningTaskId])).rows;
    expect(rows.every((r) => r.status === 'planned' && r.criteria_frozen_at)).toBe(true);
    expect(new Set(rows.map((r) => r.owner_employee_id)).size).toBe(2); // load-balanced across both engineers
  });

  it('rejects plans that leave a requirement uncovered or exceed the budget', async () => {
    const s = await objectiveWithPlanningRun();
    const bad = { ...plan, tasks: [{ ...plan.tasks[0]!, requirement_keys: ['REQ-9'], budget_usd: 500 }] };
    try {
      await s.ledger.run('proposePlan', { taskId: s.obj.planningTaskId, plan: bad }, emp(s.lead, s.d.runId, s.d.epoch));
      expect.fail('should reject');
    } catch (e) {
      expect((e as DomainError).details['errors']).toEqual(expect.arrayContaining([
        expect.stringContaining('unknown requirement "REQ-9"'), expect.stringContaining('REQ-1 is not covered'), expect.stringContaining('exceeds remaining'),
      ]));
    }
  });

  it('CEO change requests send the plan back to the lead with feedback', async () => {
    const s = await objectiveWithPlanningRun();
    const { proposalId } = await s.ledger.run('proposePlan', { taskId: s.obj.planningTaskId, plan }, emp(s.lead, s.d.runId, s.d.epoch));
    await s.ledger.run('startVerification', { taskId: s.obj.planningTaskId }, SYSTEM);
    const crit = (await s.ledger.db.query<{ id: string }>(`SELECT cr.id FROM criteria cr JOIN tasks t ON t.criteria_set_id = cr.criteria_set_id WHERE t.id = $1 ORDER BY ordinal`, [s.obj.planningTaskId])).rows;
    const sub = (await s.ledger.db.query<{ id: string }>(`SELECT id FROM submissions WHERE task_id = $1 AND status='open'`, [s.obj.planningTaskId])).rows[0]!;
    await s.ledger.run('recordEvidence', { submissionId: sub.id, criterionId: crit[0]!.id, result: 'pass', details: {}, service: { id: 'svc_plan_validator', independence: 'platform_deterministic' } }, SYSTEM);
    await s.ledger.run('evaluateTask', { taskId: s.obj.planningTaskId }, SYSTEM);
    const r = await s.ledger.run('decideProposal', { proposalId, decision: 'request_changes', rationale: 'Add a QA engineer task' }, s.ceo);
    expect(r.status).toBe('changes_requested');
    expect((await s.ledger.run('requeueAfterChanges', { taskId: s.obj.planningTaskId }, SYSTEM)).status).toBe('ready');
  });
});

describe('ledger: invariants', () => {
  it('fences stale runs after reassignment-like epoch changes (INV-7)', async () => {
    const s = await objectiveWithPlanningRun();
    expect(await errCode(s.ledger.run('proposePlan', { taskId: s.obj.planningTaskId, plan }, emp(s.lead, s.d.runId, s.d.epoch - 1)))).toBe('forbidden');
  });

  it('only the owner may submit; other employees are denied by policy', async () => {
    const s = await objectiveWithPlanningRun();
    const other = s.byRole('software_engineer')[0]!;
    expect(await errCode(s.ledger.run('proposePlan', { taskId: s.obj.planningTaskId, plan }, emp(other, s.d.runId, s.d.epoch)))).toBe('forbidden');
  });

  it('commands are idempotent: replay returns the original outcome without new events (INV-8)', async () => {
    const s = await objectiveWithPlanningRun();
    const before = Number((await s.ledger.db.query<{ n: string }>('SELECT count(*) n FROM ledger_events')).rows[0]!.n);
    const a = await s.ledger.run('postUpdate', { taskId: s.obj.planningTaskId, text: 'Drafting plan' }, emp(s.lead, s.d.runId, s.d.epoch), 'key-1');
    const b = await s.ledger.run('postUpdate', { taskId: s.obj.planningTaskId, text: 'Drafting plan' }, emp(s.lead, s.d.runId, s.d.epoch), 'key-1');
    expect(a).toEqual(b);
    const after = Number((await s.ledger.db.query<{ n: string }>('SELECT count(*) n FROM ledger_events')).rows[0]!.n);
    expect(after - before).toBe(1);
    expect(await errCode(s.ledger.run('postUpdate', { taskId: s.obj.planningTaskId, text: 'different' }, emp(s.lead, s.d.runId, s.d.epoch), 'key-1'))).toBe('idempotency_key_reuse');
  });

  it('denials are recorded in the audit chain, and the chain verifies; tampering is detected (INV-10)', async () => {
    const s = await objectiveWithPlanningRun();
    await errCode(s.ledger.run('setMode', { scopeType: 'company', scopeId: 'x', mode: 'M1', reason: 'self-escalate' }, emp(s.lead, s.d.runId, s.d.epoch)));
    const denied = await s.ledger.db.query(`SELECT 1 FROM ledger_events WHERE type = 'command.denied'`);
    expect(denied.rows.length).toBe(1);
    expect((await verifyChain(s.ledger.db)).ok).toBe(true);
    await expect(s.ledger.db.query(`UPDATE ledger_events SET payload = '{}' WHERE seq = 1`)).rejects.toThrow(/append-only/);
    // Simulate a privileged attacker bypassing the trigger: the hash chain still exposes it.
    await s.ledger.db.exec(`ALTER TABLE ledger_events DISABLE TRIGGER ledger_events_append_only; UPDATE ledger_events SET payload = '{"forged":true}' WHERE seq = 2;`);
    expect(await verifyChain(s.ledger.db)).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('the database refuses execution without frozen criteria even if application code were bypassed (INV-4)', async () => {
    const s = await objectiveWithPlanningRun();
    await expect(s.ledger.db.query(`UPDATE tasks SET criteria_frozen_at = NULL WHERE id = $1`, [s.obj.planningTaskId])).rejects.toThrow();
  });

  it('frozen criteria cannot be edited', async () => {
    const s = await objectiveWithPlanningRun();
    await expect(s.ledger.db.query(`UPDATE criteria SET statement = 'weaker' WHERE criteria_set_id = (SELECT criteria_set_id FROM tasks WHERE id = $1)`, [s.obj.planningTaskId]))
      .rejects.toThrow(/frozen/);
  });

  it('emergency stop fences in-flight runs and blocks dispatch until resumed', async () => {
    const s = await objectiveWithPlanningRun();
    const stop = await s.ledger.run('emergencyStop', { scope: { type: 'company', id: 'all' }, reason: 'drill' }, s.ceo);
    expect(stop.interruptedRuns).toContain(s.d.runId);
    expect(await errCode(s.ledger.run('postUpdate', { taskId: s.obj.planningTaskId, text: 'still here' }, emp(s.lead, s.d.runId, s.d.epoch)))).toBe('forbidden');
    const end = await s.ledger.run('endRun', { runId: s.d.runId, outcome: 'interrupted', reason: 'e-stop' }, SYSTEM);
    expect(end.taskStatus).toBeNull(); // lease already revoked; the task is held, not completed
    const t = (await s.ledger.db.query<{ hold: string; status: string }>('SELECT hold, status FROM tasks WHERE id = $1', [s.obj.planningTaskId])).rows[0]!;
    expect(t).toMatchObject({ hold: 'e_stop', status: 'in_progress' });
  });
});

describe('stray NUL bytes in agent/tool output', () => {
  it('are stripped before storage, and the hash chain still verifies', async () => {
    const { stripNul } = await import('../src/ledger/db.js');
    expect(stripNul({ a: 'x\u0000y', b: ['\u0000'], c: JSON.stringify({ out: 'bin\u0000ary' }) })).toEqual({ a: 'xy', b: [''], c: '{"out":"binary"}' });
    const s = await setupCompany('M4');
    ledger = s.ledger;
    const obj = await s.ledger.run('createObjective', { title: 'NUL\u0000 test', departmentKey: 'engineering', budgetUsd: 1,
      requirements: [{ key: 'REQ-1', text: 'Output had a NUL \u0000 byte in it' }] }, s.ceo);
    expect(obj.objectiveId).toBeTruthy();
    expect((await verifyChain(s.ledger.db)).ok).toBe(true);
  });
});
