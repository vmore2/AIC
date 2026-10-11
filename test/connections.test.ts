// "The CEO says use SQL": an engineer asks for a database, the CEO enters credentials in the dashboard,
// and the engineer works with it through the platform — never seeing the password. Runs against a real
// PostgreSQL container (skipped when Docker is not running).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { buildServer } from '../src/api/server.js';
import { ConfigSchema } from '../src/config/config.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import { inbox } from '../src/reports/views.js';
import { buildTaskContract } from '../src/runtime/context.js';
import { dept } from './helpers.js';

const IMAGE = 'postgres:16-alpine';
const PASSWORD = 'pg-Secret-4711-do-not-leak';
const dockerUp = (() => { try { execFileSync('docker', ['version'], { stdio: 'ignore', timeout: 15_000 }); return true; } catch { return false; } })();
const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-conn-'));
let app: App;
let container = '';
let port = 0;

beforeAll(async () => {
  if (!dockerUp) return;
  try { execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }); } catch { execFileSync('docker', ['pull', IMAGE], { stdio: 'ignore', timeout: 300_000 }); }
  container = execFileSync('docker', ['run', '-d', '--rm', '-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-e', 'POSTGRES_DB=shop', '-p', '127.0.0.1::5432', IMAGE], { encoding: 'utf8' }).trim();
  port = Number(execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split('\n')[0]!.split(':').pop());
  // Wait until Postgres accepts TCP logins (the image restarts once during init).
  const { checkConnection } = await import('../src/connections/databases.js');
  for (let i = 0; i < 60; i++) {
    try { await checkConnection('postgres', { host: '127.0.0.1', port, database: 'shop', user: 'postgres' }, PASSWORD); break; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
}, 400_000);
afterAll(async () => {
  await app?.close();
  if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const plan = {
  summary: 'Store orders in the PostgreSQL database the CEO chose.',
  tasks: [{ ref: 'impl', title: 'Create the orders table', kind: 'implementation', spec: 'Create an orders table and seed two rows; write code that reads them.',
    owner_role: 'software_engineer', requirement_keys: ['REQ-1'], budget_usd: 5 }],
};

describe.skipIf(!dockerUp)('connections: an employee asks for a database, the CEO provides it (real PostgreSQL)', () => {
  it('requests, waits, connects through the dashboard API, then reads and writes without ever seeing the password', async () => {
    app = await createApp(ConfigSchema.parse({
      company: { name: 'Conn' }, database: { local_path: path.join(dir, 'db') },
      models: { profiles: [{ key: 'scripted', provider: 'scripted', model: 's', family: 'f' }], default: 'scripted' },
      code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'), teams_path: path.join(dir, 'teams'),
      sandbox: { allow_unisolated_local: true },
    }));
    const b = await app.ledger.run('bootstrapCompany', { companyName: 'Conn', ceoName: 'C', defaultMode: 'M4', projectSettings: { test_command: 'node --test' } }, SYSTEM);
    const ceo: Principal = { type: 'user', id: b.ceoUserId, stepUp: true };
    const eng = dept('engineering');
    await app.ledger.run('hireDepartment', { template: eng, models: Object.fromEntries(eng.roles.map((r) => [r.key, app.config.models.profiles[0]!])) }, ceo);
    const server = buildServer(app, 'owner');
    const api = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const r = await server.inject({ method, url, payload: payload as object, headers: { 'x-aic-token': 'owner', 'content-type': 'application/json' } });
      return { status: r.statusCode, body: r.json() as Record<string, any> };
    };

    // The CEO picks the stack: every task contract carries it.
    expect((await api('POST', '/api/stack', { stack: { language: 'TypeScript', framework: 'Express', database: 'PostgreSQL' } })).status).toBe(200);

    // Lead plans; CEO approves; an engineer gets the implementation task.
    const obj = await app.ledger.run('createObjective', { title: 'Orders', departmentKey: 'engineering', budgetUsd: 20, requirements: [{ key: 'REQ-1', text: 'Orders are stored in PostgreSQL' }] }, ceo);
    await app.ledger.run('markReady', { taskId: obj.planningTaskId }, SYSTEM);
    const pd = await app.ledger.run('dispatchTask', { taskId: obj.planningTaskId }, SYSTEM);
    const lead = (await app.ledger.db.query<{ employee_id: string }>('SELECT employee_id FROM runs WHERE id = $1', [pd.runId])).rows[0]!.employee_id;
    const { proposalId } = await app.ledger.run('proposePlan', { taskId: obj.planningTaskId, plan }, { type: 'employee', id: lead, runId: pd.runId, epoch: pd.epoch });
    await app.ledger.run('startVerification', { taskId: obj.planningTaskId }, SYSTEM);
    const crit = (await app.ledger.db.query<{ id: string }>(`SELECT cr.id FROM criteria cr JOIN tasks t ON t.criteria_set_id = cr.criteria_set_id WHERE t.id = $1 ORDER BY ordinal`, [obj.planningTaskId])).rows;
    const sub = (await app.ledger.db.query<{ id: string }>(`SELECT id FROM submissions WHERE task_id = $1 AND status = 'open'`, [obj.planningTaskId])).rows[0]!;
    await app.ledger.run('recordEvidence', { submissionId: sub.id, criterionId: crit[0]!.id, result: 'pass', details: {}, service: { id: 'svc_plan_validator', independence: 'platform_deterministic' } }, SYSTEM);
    await app.ledger.run('evaluateTask', { taskId: obj.planningTaskId }, SYSTEM);
    await app.ledger.run('decideProposal', { proposalId, decision: 'approve' }, ceo);
    const { taskIds } = await app.ledger.run('materializePlan', { planningTaskId: obj.planningTaskId }, SYSTEM);
    const taskId = taskIds[0]!;
    const dispatch = async () => {
      await app.ledger.run('markReady', { taskId }, SYSTEM).catch(() => undefined);
      const d = await app.ledger.run('dispatchTask', { taskId }, SYSTEM);
      const owner = (await app.ledger.db.query<{ employee_id: string }>('SELECT employee_id FROM runs WHERE id = $1', [d.runId])).rows[0]!.employee_id;
      const token = app.gateway.issuer.issue({ runId: d.runId, employeeId: owner, taskId, epoch: d.epoch, mode: 'task' });
      return { owner, call: (name: string, args: Record<string, unknown>) => app.gateway.invoke(token, { name, arguments: args }) };
    };

    // 1) The engineer asks for a database: the task waits and the CEO's inbox shows one clear card.
    let run = await dispatch();
    const contract = await buildTaskContract(app.ledger.db, taskId, run.owner);
    expect(contract.project_stack).toMatchObject({ language: 'TypeScript', framework: 'Express', database: 'PostgreSQL' });
    expect(contract.databases).toEqual([]);
    const asked = await run.call('connections.request', { kind: 'postgres', name: 'orders db', purpose: 'Store and read customer orders for REQ-1', access: 'read_write' });
    expect(asked).toMatchObject({ ok: true, terminal: 'suspended' });
    const connectionId = JSON.parse(asked.content).connection_id as string;
    expect((await app.ledger.db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId])).rows[0]!.status).toBe('awaiting_input');
    const items = await inbox(app.ledger.db);
    expect(items.filter((i) => i.kind === 'connection')).toHaveLength(1);
    expect(items.some((i) => i.kind === 'escalation')).toBe(false);
    await app.ledger.run('endRun', { runId: (await app.ledger.db.query<{ id: string }>(`SELECT id FROM runs WHERE task_id = $1 AND status = 'running'`, [taskId])).rows[0]!.id, outcome: 'suspended' }, SYSTEM);

    // 2) The CEO tries credentials, gets a clear failure, then connects for real.
    const bad = await api('POST', '/api/connections/test', { kind: 'postgres', config: { host: '127.0.0.1', port, database: 'shop', user: 'postgres' }, password: 'wrong' });
    expect(bad.body.ok).toBe(false);
    const good = await api('POST', '/api/connections', { connection_id: connectionId, config: { host: '127.0.0.1', port, database: 'shop', user: 'postgres' }, password: PASSWORD, access: 'read_write' });
    expect(good.status).toBe(200);
    expect(good.body.check).toMatchObject({ ok: true });
    // The task resumes on its own once the database is connected.
    expect((await app.ledger.db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [taskId])).rows[0]!.status).toBe('ready');

    // The password is nowhere in the ledger, the API listing, or the vault file in plain text.
    const ledgerDump = JSON.stringify((await app.ledger.db.query('SELECT * FROM ledger_events')).rows) + JSON.stringify((await app.ledger.db.query('SELECT * FROM connections')).rows);
    expect(ledgerDump).not.toContain(PASSWORD);
    expect(JSON.stringify((await api('GET', '/api/connections')).body)).not.toContain(PASSWORD);
    const storage = path.join(dir, 'storage');
    for (const f of readdirSync(storage).filter((x) => x.endsWith('.json'))) expect(readFileSync(path.join(storage, f), 'utf8')).not.toContain(PASSWORD);

    // 3) The engineer (new run) sees the database in its contract and uses it through the platform.
    run = await dispatch();
    const after = await buildTaskContract(app.ledger.db, taskId, run.owner);
    expect(after.databases).toEqual([expect.objectContaining({ connection_id: connectionId, kind: 'postgres', access: 'read_write', status: 'active' })]);
    expect(JSON.stringify(after)).not.toContain(PASSWORD);
    const created = await run.call('db.execute', { connection_id: connectionId, sql: 'CREATE TABLE orders (id serial primary key, item text not null, qty int not null)', reason: 'REQ-1 storage' });
    expect(created.ok).toBe(true);
    const seeded = await run.call('db.execute', { connection_id: connectionId, sql: "INSERT INTO orders (item, qty) VALUES ('apple', 3), ('pear', 5)", reason: 'seed two sample orders' });
    expect(seeded.content).toMatch(/Committed/);
    const rows = await run.call('db.query', { connection_id: connectionId, sql: 'SELECT item, qty FROM orders ORDER BY id' });
    expect(JSON.parse(rows.content).rows).toEqual([{ item: 'apple', qty: 3 }, { item: 'pear', qty: 5 }]);
    // Reads cannot write, even if the model tries; one statement per call.
    const sneaky = await run.call('db.query', { connection_id: connectionId, sql: "INSERT INTO orders (item, qty) VALUES ('x', 1)" });
    expect(sneaky.ok).toBe(false);
    expect(sneaky.content).toMatch(/read-only transaction/i);
    expect((await run.call('db.query', { connection_id: connectionId, sql: 'SELECT 1; DROP TABLE orders' })).content).toMatch(/one statement/);
    const schema = JSON.parse((await run.call('db.schema', { connection_id: connectionId })).content);
    expect(schema.tables).toEqual([{ table: 'public.orders', columns: ['id integer', 'item text', 'qty integer'] }]);
    // Every write is an audited external action with the exact SQL.
    const actions = (await app.ledger.db.query<{ connector: string; status: string; payload: { sql: string } }>(`SELECT connector, status, payload FROM external_actions WHERE task_id = $1 ORDER BY created_at`, [taskId])).rows;
    expect(actions.map((a) => [a.connector, a.status])).toEqual([['db:postgres', 'succeeded'], ['db:postgres', 'succeeded']]);
    expect(actions[0]!.payload.sql).toMatch(/CREATE TABLE orders/);

    // 4) A read-only connection refuses writes; revoked connections stop working.
    const ro = await api('POST', '/api/connections', { kind: 'postgres', name: 'reporting', team: 'engineering', config: { host: '127.0.0.1', port, database: 'shop', user: 'postgres' }, password: PASSWORD, access: 'read' });
    expect(ro.status).toBe(200);
    const roId = ro.body.connectionId as string;
    expect((await run.call('db.execute', { connection_id: roId, sql: 'DELETE FROM orders', reason: 'clean up old orders' })).content).toMatch(/read-only access/);
    expect((await api('POST', `/api/connections/${roId}/revoke`, {})).status).toBe(200);
    expect((await run.call('db.query', { connection_id: roId, sql: 'SELECT 1' })).content).toMatch(/revoked/);
    expect(JSON.parse((await run.call('db.query', { connection_id: connectionId, sql: 'SELECT count(*)::int AS n FROM orders' })).content).rows[0].n).toBe(2);
  }, 300_000);
});
