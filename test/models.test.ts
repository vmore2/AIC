// The CEO brings their own models: add a provider key in the dashboard (checked for free against the
// provider's model list), choose models and prices, set the default for new hires, and switch a role to
// another model. Uses a mock OpenAI-compatible provider (no network, no spend).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { buildServer } from '../src/api/server.js';
import { ConfigSchema } from '../src/config/config.js';
import { SYSTEM } from '../src/domain/types.js';

const KEY = 'sk-test-ceo-owned-key-998877';
const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-models-'));
let app: App;
let provider: Server;
const seenAuth: string[] = [];
afterAll(async () => { provider?.close(); await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

async function mockProvider(): Promise<string> {
  provider = createServer((req, res) => {
    const auth = String(req.headers.authorization ?? '');
    seenAuth.push(auth);
    if (auth !== `Bearer ${KEY}`) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"invalid key"}}'); return; }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-small' }, { id: 'mock-large' }] })); return; }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'hello from the CEO\'s model' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
}

describe('CEO-managed models and keys', () => {
  it('adds a provider key, picks models, hires with them and switches a role — the key never leaves the vault', async () => {
    app = await createApp(ConfigSchema.parse({
      company: { name: 'Models' }, database: { local_path: path.join(dir, 'db') },
      models: { profiles: [{ key: 'scripted', provider: 'scripted', model: 's', family: 'f' }], default: 'scripted' },
      code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'), teams_path: path.join(dir, 'teams'),
    }));
    await app.ledger.run('bootstrapCompany', { companyName: 'Models', ceoName: 'C', defaultMode: 'M4' }, SYSTEM);
    const server = buildServer(app, 'owner');
    const api = async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const r = await server.inject({ method, url, payload: payload as object, headers: { 'x-aic-token': 'owner', 'content-type': 'application/json' } });
      return { status: r.statusCode, body: r.json() as Record<string, unknown> & Record<string, never>, raw: r.body };
    };
    const base = await mockProvider();

    // The setup checklist starts with "connect a model".
    const setup = await api('GET', '/api/setup');
    expect(setup.body.steps[0]).toMatchObject({ key: 'models', done: false });

    // A wrong key is rejected before anything is stored; the right key reveals the provider's models.
    const wrong = await api('POST', '/api/providers', { kind: 'custom', label: 'Mock AI', base_url: base, api_key: 'sk-wrong-key-123' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.title).toMatch(/rejected this key/);
    const added = await api('POST', '/api/providers', { kind: 'custom', label: 'Mock AI', base_url: base, api_key: KEY });
    expect(added.status).toBe(200);
    expect(added.body.available).toEqual(['mock-large', 'mock-small']);
    const providerId = added.body.providerId as string;

    // Models with the CEO's prices; the first one becomes the default for new hires.
    expect((await api('POST', '/api/models', { provider_id: providerId, model: 'mock-small', family: 'mock', input_price: 0.1, output_price: 0.4 })).status).toBe(200);
    expect((await api('POST', '/api/models', { provider_id: providerId, model: 'mock-large', family: 'mock-b', input_price: 2, output_price: 8 })).status).toBe(200);
    expect((await api('POST', '/api/models', { provider_id: providerId, model: 'mock-small' })).status).toBe(409);
    expect((await api('POST', '/api/models/default', { key: 'mock-small' })).status).toBe(200);
    const listing = await api('GET', '/api/models');
    expect(listing.raw).not.toContain(KEY);
    expect((listing.body.providers as { key_fingerprint: string }[])[0]!.key_fingerprint).toMatch(/^sk-…8877 · [0-9a-f]{4}$/);
    expect(listing.body.default_model).toBe('mock-small');

    // Hiring uses the default; the CEO moves reviewers to a different model family.
    expect((await api('POST', '/api/catalog/engineering/hire', {})).status).toBe(200);
    const models = async (role: string) => (await app.ledger.db.query<{ model_profile: string; model_family: string }>(
      `SELECT DISTINCT model_profile, model_family FROM employees WHERE role_key = $1`, [role])).rows;
    expect(await models('software_engineer')).toEqual([{ model_profile: 'mock-small', model_family: 'mock' }]);
    expect((await api('POST', '/api/teams/engineering/roles/code_reviewer/model', { key: 'mock-large' })).body).toEqual({ employees: 1 });
    expect(await models('code_reviewer')).toEqual([{ model_profile: 'mock-large', model_family: 'mock-b' }]);
    expect((await api('POST', '/api/teams/engineering/roles/code_reviewer/model', { key: 'nope' })).status).toBe(404);

    // A real call: the platform reads the key from the vault and sends it only to the provider.
    seenAuth.length = 0;
    const r = await app.models.create('mock-small', { roleKey: 'software_engineer', category: 'producer', mode: 'task' })
      .generate({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(r.text).toBe("hello from the CEO's model");
    expect(seenAuth).toEqual([`Bearer ${KEY}`]);

    // The key is encrypted at rest and absent from the ledger.
    const storage = path.join(dir, 'storage');
    for (const f of readdirSync(storage).filter((x) => x.endsWith('.json'))) expect(readFileSync(path.join(storage, f), 'utf8')).not.toContain(KEY);
    expect(JSON.stringify((await app.ledger.db.query('SELECT * FROM ledger_events')).rows)).not.toContain(KEY);
    expect(JSON.stringify((await app.ledger.db.query('SELECT * FROM model_providers')).rows)).not.toContain(KEY);

    // A provider whose models people use can't be pulled out from under them.
    expect((await api('POST', `/api/providers/${providerId}/remove`, {})).status).toBe(409);

    // The checklist reflects progress.
    const done = (await api('GET', '/api/setup')).body.steps as { key: string; done: boolean }[];
    expect(done.filter((s) => s.done).map((s) => s.key)).toEqual(['models', 'teams']);
  }, 120_000);
});
