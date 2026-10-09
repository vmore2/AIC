import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { ConfigSchema } from '../src/config/config.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import { git } from '../src/execution/codeHost.js';
import { buildTaskContract } from '../src/runtime/context.js';
import { dept } from './helpers.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-reg-'));
let app: App;
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

async function setup() {
  app = await createApp(ConfigSchema.parse({
    company: { name: 'Reg' }, database: { local_path: path.join(dir, 'db') },
    models: { profiles: [{ key: 'scripted', provider: 'scripted', model: 's', family: 'a' }, { key: 'rev', provider: 'scripted', model: 's', family: 'b' }],
      default: 'scripted', assignments: { code_reviewer: 'rev' } },
    code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'), teams_path: path.join(dir, 'teams'),
    sandbox: { allow_unisolated_local: true },
  }));
  const b = await app.ledger.run('bootstrapCompany', { companyName: 'Reg', ceoName: 'C', defaultMode: 'M4', projectSettings: { test_command: 'node --test' } }, SYSTEM);
  const ceo: Principal = { type: 'user', id: b.ceoUserId, stepUp: true };
  const eng = dept('engineering');
  await app.ledger.run('hireDepartment', { template: eng, models: Object.fromEntries(eng.roles.map((r) => [r.key, app.config.models.profiles[r.category === 'reviewer' ? 1 : 0]!])) }, ceo);
  const obj = await app.ledger.run('createObjective', { title: 'Slugs', departmentKey: 'engineering', budgetUsd: 100,
    requirements: [{ key: 'REQ-1', text: 'Provide slugify(text): lowercase words joined by single hyphens, punctuation removed, no leading or trailing hyphens.' }] }, ceo);
  await app.orchestrator.runUntilIdle(60_000);
  const prop = (await app.ledger.db.query<{ id: string }>('SELECT id FROM proposals WHERE task_id = $1', [obj.planningTaskId])).rows[0]!;
  await app.ledger.run('decideProposal', { proposalId: prop.id, decision: 'approve' }, ceo);
  return { ceo, obj };
}

describe('reassignment and regression detection', () => {
  it('reassigning in-flight work fences the old run and re-dispatches to the new owner', async () => {
    const { ceo, obj } = await setup();
    await app.ledger.run('materializePlan', { planningTaskId: obj.planningTaskId }, SYSTEM);
    const impl = (await app.ledger.db.query<{ id: string; owner_employee_id: string }>(`SELECT id, owner_employee_id FROM tasks WHERE parent_task_id = $1 AND title LIKE 'Deliver%'`, [obj.planningTaskId])).rows[0]!;
    await app.ledger.run('markReady', { taskId: impl.id }, SYSTEM);
    const d = await app.ledger.run('dispatchTask', { taskId: impl.id }, SYSTEM);
    const other = (await app.ledger.db.query<{ id: string }>(`SELECT id FROM employees WHERE role_key = 'software_engineer' AND id <> $1`, [impl.owner_employee_id])).rows[0]!;
    const reviewer = (await app.ledger.db.query<{ id: string }>(`SELECT id FROM employees WHERE role_key = 'code_reviewer'`)).rows[0]!;

    await expect(app.ledger.run('reassignTask', { taskId: impl.id, employeeId: reviewer.id, reason: 'try reviewer' }, ceo)).rejects.toThrow(/target_not_reviewer/);
    const r = await app.ledger.run('reassignTask', { taskId: impl.id, employeeId: other.id, reason: 'balance load' }, ceo);
    expect(r.status).toBe('ready');
    // The previous owner's run can no longer act (stale epoch).
    await expect(app.ledger.run('postUpdate', { taskId: impl.id, text: 'still working' }, { type: 'employee', id: impl.owner_employee_id, runId: d.runId, epoch: d.epoch })).rejects.toThrow();
    const run = (await app.ledger.db.query<{ status: string }>('SELECT status FROM runs WHERE id = $1', [d.runId])).rows[0]!;
    expect(run.status).toBe('interrupted');
    const d2 = await app.ledger.run('dispatchTask', { taskId: impl.id }, SYSTEM);
    const run2 = (await app.ledger.db.query<{ employee_id: string }>('SELECT employee_id FROM runs WHERE id = $1', [d2.runId])).rows[0]!;
    expect(run2.employee_id).toBe(other.id);
    expect(d2.epoch).toBeGreaterThan(d.epoch);
    await app.close();
    app = undefined as unknown as App;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }, 120_000);

  it('reopens accepted work when its checks fail on the integration branch', async () => {
    const { obj } = await setup();
    await app.orchestrator.runUntilIdle(120_000);
    const impl = (await app.ledger.db.query<{ id: string; status: string }>(`SELECT id, status FROM tasks WHERE parent_task_id = $1 AND title LIKE 'Deliver%'`, [obj.planningTaskId])).rows[0]!;
    expect(impl.status).toBe('accepted');
    expect(await app.orchestrator.checkIntegration(impl.id)).toBe(false); // integration is green

    // Something lands on the integration branch that breaks the suite.
    const work = path.join(dir, 'breaker');
    await git(dir, ['clone', '--quiet', '--branch', app.workspaces.integrationBranch(obj.objectiveId), path.join(dir, 'repo.git'), work]);
    writeFileSync(path.join(work, 'test', 'regression.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slugify.js';\ntest('unicode', () => assert.equal(slugify('Café Crème'), 'cafe-creme'));\n");
    await git(work, ['add', '-A']);
    await git(work, ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'add unicode test']);
    await git(work, ['push', '-q', 'origin', 'HEAD']);

    expect(await app.orchestrator.checkIntegration(impl.id)).toBe(true);
    const after = (await app.ledger.db.query<{ status: string; attempt: number }>('SELECT status, attempt FROM tasks WHERE id = $1', [impl.id])).rows[0]!;
    expect(after).toMatchObject({ status: 'ready', attempt: 0 });
    const o = (await app.ledger.db.query<{ status: string }>('SELECT status FROM objectives WHERE id = $1', [obj.objectiveId])).rows[0]!;
    expect(o.status).toBe('active');
    const owner = (await app.ledger.db.query<{ owner_employee_id: string }>('SELECT owner_employee_id FROM tasks WHERE id = $1', [impl.id])).rows[0]!;
    const contract = await buildTaskContract(app.ledger.db, impl.id, owner.owner_employee_id);
    expect(contract.prior_attempt_feedback.join('\n')).toMatch(/Regression: .*fails on the integration branch/s);
  }, 240_000);
});
