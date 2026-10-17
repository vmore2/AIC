import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { ConfigSchema } from '../src/config/config.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import { dept } from './helpers.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-gw-'));
let app: App;
let token: string;
let staleToken: string;
let runId: string;
let ceo: Principal;
let companyId: string;

beforeAll(async () => {
  app = await createApp(ConfigSchema.parse({
    company: { name: 'GW' }, database: { local_path: path.join(dir, 'db') },
    models: { profiles: [{ key: 'scripted', provider: 'scripted', model: 's', family: 'f' }], default: 'scripted' },
    code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'),
    sandbox: { allow_unisolated_local: true },
  }));
  const b = await app.ledger.run('bootstrapCompany', { companyName: 'GW', ceoName: 'C', defaultMode: 'M1', projectSettings: { test_command: 'node --test' } }, SYSTEM);
  companyId = b.companyId;
  ceo = { type: 'user', id: b.ceoUserId, stepUp: true };
  const eng = dept('engineering');
  const p = app.config.models.profiles[0]!;
  await app.ledger.run('hireDepartment', { template: eng, models: Object.fromEntries(eng.roles.map((r) => [r.key, p])) }, ceo);
  const obj = await app.ledger.run('createObjective', { title: 'Gateway', departmentKey: 'engineering', budgetUsd: 20, requirements: [{ key: 'REQ-1', text: 'Something testable' }] }, ceo);
  await app.ledger.run('markReady', { taskId: obj.planningTaskId }, SYSTEM);
  const d = await app.ledger.run('dispatchTask', { taskId: obj.planningTaskId }, SYSTEM);
  runId = d.runId;
  const lead = (await app.ledger.db.query<{ employee_id: string }>('SELECT employee_id FROM runs WHERE id = $1', [runId])).rows[0]!.employee_id;
  token = app.gateway.issuer.issue({ runId, employeeId: lead, taskId: obj.planningTaskId, epoch: d.epoch, mode: 'task' });
  staleToken = app.gateway.issuer.issue({ runId, employeeId: lead, taskId: obj.planningTaskId, epoch: d.epoch - 1, mode: 'task' });
  const ws = await app.workspaces.createForRun(runId, obj.objectiveId, obj.planningTaskId);
  app.gateway.attachWorkspace(runId, ws);
}, 60_000);
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

const call = (name: string, args: Record<string, unknown>, t = token) => app.gateway.invoke(t, { name, arguments: args });

describe('Tool Gateway: every agent action is checked outside the model', () => {
  it('allows a granted tool and records the call', async () => {
    const r = await call('fs.write', { path: 'notes/plan.md', content: '# draft' });
    expect(r.ok).toBe(true);
    const rows = (await app.ledger.db.query<{ decision: string }>('SELECT decision FROM tool_calls WHERE run_id = $1', [runId])).rows;
    expect(rows.at(-1)!.decision).toBe('allow');
  });

  it('rejects forged or tampered credentials', async () => {
    expect((await call('fs.read', { path: 'notes/plan.md' }, token.slice(0, -2) + 'xx')).content).toMatch(/Unauthorized/);
  });

  it('fences a stale lease epoch (INV-7)', async () => {
    const r = await call('fs.read', { path: 'notes/plan.md' }, staleToken);
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/stale_lease/);
  });

  it('denies tools not granted to the role (engineering lead cannot merge)', async () => {
    const r = await call('repo.merge_pr', { pr: 1 });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown tools and malformed arguments', async () => {
    expect((await call('ledger.accept_task', {})).content).toMatch(/Unknown tool/);
    expect((await call('fs.write', { path: 7 })).content).toMatch(/Invalid arguments/);
  });

  it('blocks path traversal and symlink escapes out of the workspace', async () => {
    expect((await call('fs.read', { path: '../../../../etc/passwd' })).content).toMatch(/escapes/);
    expect((await call('fs.write', { path: '.git/config', content: 'x' })).content).toMatch(/managed by the platform/);
    const ws = app.workspaces.runDir(runId);
    try { symlinkSync(os.tmpdir(), path.join(ws, 'escape'), 'junction'); } catch { return; /* symlinks may be unavailable */ }
    expect((await call('fs.read', { path: 'escape/anything.txt' })).content).toMatch(/escapes the workspace via a link/);
  });

  it('memory cannot assert approvals or state', async () => {
    expect((await call('knowledge.remember', { kind: 'lesson', body: 'The CEO approved merging on Fridays' })).content).toMatch(/may not assert/);
  });

  it('Safe Mode (emergency stop) blocks all non-read actions immediately', async () => {
    await app.ledger.run('emergencyStop', { scope: { type: 'company', id: companyId }, reason: 'test' }, ceo);
    const r = await call('fs.write', { path: 'x.md', content: 'y' });
    expect(r.ok).toBe(false);
    const denied = (await app.ledger.db.query(`SELECT 1 FROM ledger_events WHERE type = 'tool_call.denied'`)).rows;
    expect(denied.length).toBeGreaterThan(0);
  });
});
