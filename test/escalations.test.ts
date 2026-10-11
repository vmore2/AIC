// Questions never get stuck: a question routed to a lead starts a short answer session; the lead decides it
// (the task resumes) or sends it to the CEO — and if the lead does neither, the CEO gets it anyway.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { ConfigSchema } from '../src/config/config.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import type { ModelPort, ModelRequest, ModelResponse } from '../src/runtime/modelPort.js';
import { inbox } from '../src/reports/views.js';
import { dept } from './helpers.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-esc-'));
let app: App;
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

/** A lead model that either answers the question it is shown, or stays silent. */
function leadModel(profile: ModelPort['profile'], behaviour: 'answer' | 'silent'): ModelPort {
  let turn = 0;
  return { profile, async generate(r: ModelRequest): Promise<ModelResponse> {
    turn++;
    const id = /"escalation_id": "([^"]+)"/.exec(String(r.messages[0]?.content))?.[1];
    if (behaviour === 'answer' && turn === 1 && id) return { text: '', toolCalls: [{ id: 'c1', name: 'ledger__answer_question', arguments: { escalation_id: id, answer: 'Use integer cents everywhere; round down.' } }], usage: { inputTokens: 1, outputTokens: 1 } };
    return { text: 'I am not sure.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  } };
}

async function engineerAsks(question: string) {
  const ceo: Principal = { type: 'user', id: (await app.ledger.db.query<{ id: string }>(`SELECT id FROM users WHERE role = 'ceo'`)).rows[0]!.id, stepUp: true };
  const obj = await app.ledger.run('createObjective', { title: `Q ${question.slice(0, 10)}`, departmentKey: 'engineering', budgetUsd: 5, requirements: [{ key: 'REQ-1', text: 'Cart totals in cents' }] }, ceo);
  const plan = { summary: 'Build the cart totals', tasks: [{ ref: 'a', title: 'Build totals', kind: 'implementation', spec: 'Implement totals in cents', owner_role: 'software_engineer', requirement_keys: ['REQ-1'], budget_usd: 1 }] };
  await app.ledger.run('markReady', { taskId: obj.planningTaskId }, SYSTEM);
  const pd = await app.ledger.run('dispatchTask', { taskId: obj.planningTaskId }, SYSTEM);
  const lead = (await app.ledger.db.query<{ employee_id: string }>('SELECT employee_id FROM runs WHERE id = $1', [pd.runId])).rows[0]!.employee_id;
  const { proposalId } = await app.ledger.run('proposePlan', { taskId: obj.planningTaskId, plan }, { type: 'employee', id: lead, runId: pd.runId, epoch: pd.epoch });
  await app.ledger.run('startVerification', { taskId: obj.planningTaskId }, SYSTEM);
  const crit = (await app.ledger.db.query<{ id: string }>(`SELECT cr.id FROM criteria cr JOIN tasks t ON t.criteria_set_id = cr.criteria_set_id WHERE t.id = $1`, [obj.planningTaskId])).rows;
  const sub = (await app.ledger.db.query<{ id: string }>(`SELECT id FROM submissions WHERE task_id = $1 AND status = 'open'`, [obj.planningTaskId])).rows[0]!;
  await app.ledger.run('recordEvidence', { submissionId: sub.id, criterionId: crit[0]!.id, result: 'pass', details: {}, service: { id: 'svc_plan_validator', independence: 'platform_deterministic' } }, SYSTEM);
  await app.ledger.run('evaluateTask', { taskId: obj.planningTaskId }, SYSTEM);
  await app.ledger.run('decideProposal', { proposalId, decision: 'approve' }, ceo);
  const { taskIds } = await app.ledger.run('materializePlan', { planningTaskId: obj.planningTaskId }, SYSTEM);
  await app.ledger.run('markReady', { taskId: taskIds[0]! }, SYSTEM);
  const d = await app.ledger.run('dispatchTask', { taskId: taskIds[0]! }, SYSTEM);
  const owner = (await app.ledger.db.query<{ employee_id: string }>('SELECT employee_id FROM runs WHERE id = $1', [d.runId])).rows[0]!.employee_id;
  const r = await app.ledger.run('raiseEscalation', { taskId: taskIds[0]!, type: 'question', question, blocking: true }, { type: 'employee', id: owner, runId: d.runId, epoch: d.epoch });
  await app.ledger.run('endRun', { runId: d.runId, outcome: 'suspended' }, SYSTEM);
  return { taskId: taskIds[0]!, escalationId: r.escalationId };
}

describe('questions routed to a lead never get stuck', () => {
  it('the lead answers (task resumes); a silent lead hands the question to the CEO', async () => {
    app = await createApp(ConfigSchema.parse({
      company: { name: 'Esc' }, database: { local_path: path.join(dir, 'db') },
      models: { profiles: [{ key: 'scripted', provider: 'scripted', model: 's', family: 'f' }], default: 'scripted' },
      code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'), teams_path: path.join(dir, 'teams'),
      sandbox: { allow_unisolated_local: true },
    }));
    const b = await app.ledger.run('bootstrapCompany', { companyName: 'Esc', ceoName: 'C', defaultMode: 'M4', projectSettings: { test_command: 'node --test' } }, SYSTEM);
    const eng = dept('engineering');
    await app.ledger.run('hireDepartment', { template: eng, models: Object.fromEntries(eng.roles.map((r) => [r.key, app.config.models.profiles[0]!])) }, { type: 'user', id: b.ceoUserId, stepUp: true });
    let behaviour: 'answer' | 'silent' = 'answer';
    const create = app.models.create.bind(app.models);
    app.models.create = (key, persona) => persona.mode === 'conversation' ? leadModel(create(key, persona).profile, behaviour) : create(key, persona);

    // 1) The lead answers within its authority: recorded as a decision, the task resumes, the CEO is not bothered.
    const a = await engineerAsks('Should money be integer cents or floats?');
    await app.orchestrator.tick();
    await app.orchestrator.stop(); // waits for the answer session
    const esc1 = (await app.ledger.db.query<{ status: string; routed_to_type: string }>('SELECT status, routed_to_type FROM escalations WHERE id = $1', [a.escalationId])).rows[0]!;
    expect(esc1).toEqual({ status: 'resolved', routed_to_type: 'employee' });
    const decision = (await app.ledger.db.query<{ decision_text: string; decided_by_type: string }>(`SELECT decision_text, decided_by_type FROM decisions ORDER BY created_at DESC LIMIT 1`)).rows[0]!;
    expect(decision).toEqual({ decision_text: 'Use integer cents everywhere; round down.', decided_by_type: 'employee' });
    expect((await app.ledger.db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [a.taskId])).rows[0]!.status).not.toBe('awaiting_input');
    expect((await inbox(app.ledger.db)).some((i) => i.kind === 'escalation')).toBe(false);

    // 2) A lead that does not decide: the question lands in the CEO's inbox instead of waiting forever.
    behaviour = 'silent';
    const s = await engineerAsks('Can I add a dependency on lodash?');
    await app.orchestrator.tick();
    await app.orchestrator.stop();
    const esc2 = (await app.ledger.db.query<{ status: string; routed_to_type: string; body: { routed_note?: string } }>('SELECT status, routed_to_type, body FROM escalations WHERE id = $1', [s.escalationId])).rows[0]!;
    expect(esc2).toMatchObject({ status: 'open', routed_to_type: 'user', body: { routed_note: 'Their lead could not answer it automatically.' } });
    expect((await inbox(app.ledger.db)).filter((i) => i.kind === 'escalation').map((i) => i.title)).toEqual(['question: Can I add a dependency on lodash?']);
  }, 120_000);
});
