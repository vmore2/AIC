// The CEO shapes how every employee works with standing instructions at any level of the org, and runs
// the company alone from the dashboard: new objectives, oversight per team. (Scripted model; no spend.)
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { buildServer } from '../src/api/server.js';
import { ConfigSchema } from '../src/config/config.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import { buildReviewContext, buildTaskContract } from '../src/runtime/context.js';
import { dept } from './helpers.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-ins-'));
let app: App;
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

describe('CEO instructions and running the company from the dashboard', () => {
  it('layers company → team → role → employee instructions into exactly the right contracts, with history', async () => {
    app = await createApp(ConfigSchema.parse({
      company: { name: 'Ins' }, database: { local_path: path.join(dir, 'db') },
      models: { profiles: [{ key: 'scripted', provider: 'scripted', model: 's', family: 'f' }], default: 'scripted' },
      code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'), teams_path: path.join(dir, 'teams'),
      sandbox: { allow_unisolated_local: true },
    }));
    const b = await app.ledger.run('bootstrapCompany', { companyName: 'Ins', ceoName: 'C', defaultMode: 'M4' }, SYSTEM);
    const ceo: Principal = { type: 'user', id: b.ceoUserId, stepUp: true };
    const eng = dept('engineering');
    await app.ledger.run('hireDepartment', { template: eng, models: Object.fromEntries(eng.roles.map((r) => [r.key, app.config.models.profiles[0]!])) }, ceo);
    const viewer = await app.ledger.run('addUser', { name: 'Vic', role: 'viewer' }, ceo);
    const vt = await app.ledger.run('issueAccessToken', { userId: viewer.userId, label: 'v' }, ceo);
    const server = buildServer(app, 'owner');
    const api = async (method: 'GET' | 'POST', url: string, payload?: unknown, token = 'owner') => {
      const r = await server.inject({ method, url, payload: payload as object, headers: { 'x-aic-token': token, 'content-type': 'application/json' } });
      return { status: r.statusCode, body: r.json() as any };
    };
    const emps = (await app.ledger.db.query<{ id: string; role_key: string }>('SELECT id, role_key FROM employees ORDER BY created_at')).rows;
    const [se1, se2] = emps.filter((e) => e.role_key === 'software_engineer');
    const reviewer = emps.find((e) => e.role_key === 'code_reviewer')!;

    expect((await api('POST', '/api/instructions', { scope_type: 'company', body: 'Write for a non-technical CEO: plain words, no jargon.' })).status).toBe(200);
    expect((await api('POST', '/api/instructions', { scope_type: 'department', team: 'engineering', body: 'Prefer the standard library over new dependencies.' })).status).toBe(200);
    expect((await api('POST', '/api/instructions', { scope_type: 'role', team: 'engineering', role: 'software_engineer', body: 'Add a JSDoc comment to every exported function.' })).status).toBe(200);
    expect((await api('POST', '/api/instructions', { scope_type: 'employee', employee: se1!.id, body: 'You are the edge-case specialist: test empty and unicode input.' })).status).toBe(200);
    // Viewers can read but not set instructions; bad scopes are refused.
    expect((await api('POST', '/api/instructions', { scope_type: 'company', body: 'x' }, vt.token)).status).toBe(403);
    expect((await api('POST', '/api/instructions', { scope_type: 'role', team: 'engineering', role: 'astronaut', body: 'x' })).status).toBe(404);
    expect((await api('GET', '/api/instructions', undefined, vt.token)).body.map((i: { label: string }) => i.label))
      .toEqual(['Whole company', 'Software Engineering', 'Software Engineering · Software Engineer', 'Software Engineer 1']);

    // A task contract carries them broadest-first; each employee gets only what applies to them.
    const obj = await app.ledger.run('createObjective', { title: 'Docs', departmentKey: 'engineering', budgetUsd: 5, requirements: [{ key: 'REQ-1', text: 'Something' }] }, ceo);
    const lead = emps.find((e) => e.role_key === 'engineering_lead')!;
    const forLead = await buildTaskContract(app.ledger.db, obj.planningTaskId, lead.id);
    expect(forLead.ceo_instructions.map((i) => i.from)).toEqual(['the whole company', 'your team']);
    const forSe1 = await buildTaskContract(app.ledger.db, obj.planningTaskId, se1!.id);
    expect(forSe1.ceo_instructions).toEqual([
      { from: 'the whole company', text: 'Write for a non-technical CEO: plain words, no jargon.' },
      { from: 'your team', text: 'Prefer the standard library over new dependencies.' },
      { from: 'everyone in your role', text: 'Add a JSDoc comment to every exported function.' },
      { from: 'you personally', text: 'You are the edge-case specialist: test empty and unicode input.' },
    ]);
    const forSe2 = await buildTaskContract(app.ledger.db, obj.planningTaskId, se2!.id);
    expect(forSe2.ceo_instructions.map((i) => i.from)).toEqual(['the whole company', 'your team', 'everyone in your role']);
    // Instructions never change what an employee may do.
    expect(forSe1.permissions).toEqual(forSe2.permissions);
    // Reviewers get their own instructions, never the author's.
    const rc = await buildReviewContext(app.ledger.db, obj.planningTaskId, 'none', '', reviewer.id);
    expect(rc.ceo_instructions.map((i) => i.from)).toEqual(['the whole company', 'your team']);

    // Updating keeps history; clearing removes it from contracts.
    await api('POST', '/api/instructions', { scope_type: 'role', team: 'engineering', role: 'software_engineer', body: 'Add JSDoc with an example to every exported function.' });
    const hist = (await app.ledger.db.query<{ version: number; status: string }>(`SELECT version, status FROM instructions WHERE scope_type = 'role' ORDER BY version`)).rows;
    expect(hist).toEqual([{ version: 1, status: 'superseded' }, { version: 2, status: 'active' }]);
    await api('POST', '/api/instructions', { scope_type: 'employee', employee: se1!.id, body: '' });
    expect((await buildTaskContract(app.ledger.db, obj.planningTaskId, se1!.id)).ceo_instructions.at(-1)!.text).toBe('Add JSDoc with an example to every exported function.');
    expect((await app.ledger.db.query(`SELECT 1 FROM ledger_events WHERE type IN ('instructions.set','instructions.cleared')`)).rows.length).toBe(6);

    // Running the company alone: objectives from a form, oversight per team.
    const created = await api('POST', '/api/objectives', { title: 'Pricing page', team: 'engineering', requirements: ['Show three plans', 'Annual toggle saves 20%'], budget_usd: 3 });
    expect(created.status).toBe(200);
    const reqs = (await api('GET', `/api/objectives/${created.body.objectiveId}/requirements`)).body;
    expect(reqs.map((r: { key: string }) => r.key)).toEqual(['REQ-1', 'REQ-2']);
    expect((await api('POST', '/api/objectives', { title: 'Empty', team: 'engineering', requirements: [], budget_usd: 3 })).status).toBe(400);
    expect((await api('POST', '/api/teams/engineering/mode', { mode: 'M5', reason: 'new team, watch closely' })).status).toBe(200);
    expect((await app.ledger.db.query<{ mode: string }>(`SELECT m.mode FROM mode_settings m JOIN departments d ON d.id = m.scope_id WHERE d.key = 'engineering'`)).rows[0]!.mode).toBe('M5');
    expect((await api('POST', '/api/teams/engineering/mode', { mode: 'M9' })).status).toBe(400);
    const cancel = await api('POST', `/api/tasks/${created.body.planningTaskId}/cancel`, { reason: 'changed my mind' });
    expect(cancel.body.status).toBe('cancelled');
  }, 120_000);
});
