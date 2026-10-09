import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { buildServer, startServer } from '../src/api/server.js';
import { ConfigSchema } from '../src/config/config.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import { dept } from './helpers.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-acc-'));
let app: App;
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

describe('dashboard server, team access tokens, and CI webhook', () => {
  it('serves, scopes teammates by role, and reopens work when CI reports a failure', async () => {
    app = await createApp(ConfigSchema.parse({
      company: { name: 'Acc' }, database: { local_path: path.join(dir, 'db') },
      models: { profiles: [{ key: 'scripted', provider: 'scripted', model: 's', family: 'a' }, { key: 'rev', provider: 'scripted', model: 's', family: 'b' }],
        default: 'scripted', assignments: { fact_checker: 'rev' } },
      code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'), teams_path: path.join(dir, 'teams'),
    }));
    const b = await app.ledger.run('bootstrapCompany', { companyName: 'Acc', ceoName: 'Casey', defaultMode: 'M1' }, SYSTEM);
    const ceo: Principal = { type: 'user', id: b.ceoUserId, stepUp: true };

    // 1) `aic serve` really listens and runs the orchestrator.
    process.env['AIC_DASHBOARD_TOKEN'] = 'owner-token-123';
    const live = await startServer(app, 0);
    const port = (live.server.address() as AddressInfo).port;
    const me = await fetch(`http://127.0.0.1:${port}/api/me`, { headers: { 'x-aic-token': 'owner-token-123' } });
    expect(await me.json()).toMatchObject({ name: 'Casey', role: 'ceo', owner: true });
    await live.close();
    await app.orchestrator.stop();
    delete process.env['AIC_DASHBOARD_TOKEN'];

    // 2) Teammates get personal tokens; the policy engine scopes what each role may do.
    const server = buildServer(app, 'owner');
    const call = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
      server.inject({ method, url, payload: payload as object, headers: { 'x-aic-token': token, 'content-type': 'application/json' } });
    const viewer = await app.ledger.run('addUser', { name: 'Vic Viewer', role: 'viewer' }, ceo);
    const vt = await app.ledger.run('issueAccessToken', { userId: viewer.userId, label: 'viewer' }, ceo);
    const approver = await app.ledger.run('addUser', { name: 'Ava Approver', role: 'approver' }, ceo);
    const at = await app.ledger.run('issueAccessToken', { userId: approver.userId, label: 'approver' }, ceo);
    expect((await call(vt.token, 'GET', '/api/status')).statusCode).toBe(200);
    expect((await call(vt.token, 'GET', '/api/me')).json()).toMatchObject({ role: 'viewer', owner: false });
    expect((await call(vt.token, 'POST', '/api/emergency-stop', { reason: 'x' })).statusCode).toBe(403);
    expect((await call(at.token, 'POST', '/api/catalog/research/hire', {})).statusCode).toBe(403); // hiring is governance
    expect((await call(at.token, 'POST', '/api/teams', { spec: {} })).statusCode).toBe(403);
    await app.ledger.run('revokeAccessToken', { tokenId: vt.tokenId }, ceo);
    expect((await call(vt.token, 'GET', '/api/status')).statusCode).toBe(401);
    await expect(app.ledger.run('issueAccessToken', { userId: viewer.userId, label: 'x' }, { type: 'user', id: approver.userId })).rejects.toThrow(/Policy denied/);

    // 3) Run an objective to acceptance (Autonomous mode, standard risk: no human gates).
    const research = dept('research');
    await app.ledger.run('hireDepartment', { template: research, models: Object.fromEntries(research.roles.map((r) => [r.key, app.config.models.profiles[r.category === 'reviewer' ? 1 : 0]!])) }, ceo);
    const obj = await app.ledger.run('createObjective', { title: 'Pricing scan', departmentKey: 'research', budgetUsd: 40,
      requirements: [{ key: 'REQ-1', text: 'Compare competitor pricing pages and summarize tiers.' }] }, ceo);
    await app.orchestrator.runUntilIdle(120_000);
    const task = (await app.ledger.db.query<{ id: string; status: string }>(`SELECT id, status FROM tasks WHERE parent_task_id = $1`, [obj.planningTaskId])).rows[0]!;
    expect(task.status).toBe('accepted');
    const sha = (await app.ledger.db.query<{ external_ref: string }>(`SELECT external_ref FROM artifact_versions WHERE produced_by_task = $1 ORDER BY created_at DESC LIMIT 1`, [task.id])).rows[0]!.external_ref.slice(4);

    // 4) CI webhook: signed, attributed through the ledger, reopens the task.
    const hook = (body: object, secret = 'ci-secret') => {
      const raw = JSON.stringify(body);
      return server.inject({ method: 'POST', url: '/api/hooks/ci', payload: raw, headers: { 'content-type': 'application/json', 'x-aic-signature': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` } });
    };
    expect((await hook({ sha, status: 'failure', name: 'ci' })).statusCode).toBe(503); // not configured yet
    process.env['AIC_CI_WEBHOOK_SECRET'] = 'ci-secret';
    expect((await hook({ sha, status: 'failure', name: 'ci' }, 'wrong')).statusCode).toBe(401);
    expect((await hook({ sha: 'abcdef1234567', status: 'failure', name: 'ci' })).json()).toEqual({ attributedTo: null, reopened: false });
    const r = await hook({ sha, status: 'failure', name: 'GitHub Actions / test', url: 'https://ci.example/run/1', delivery_id: 'd1' });
    expect(r.json()).toEqual({ attributedTo: task.id, reopened: true });
    expect((await hook({ sha, status: 'failure', name: 'GitHub Actions / test', url: 'https://ci.example/run/1', delivery_id: 'd1' })).json()).toEqual({ attributedTo: task.id, reopened: true }); // idempotent redelivery
    const after = (await app.ledger.db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [task.id])).rows[0]!;
    expect(after.status).toBe('ready');
    delete process.env['AIC_CI_WEBHOOK_SECRET'];
    await server.close();
  }, 240_000);
});
