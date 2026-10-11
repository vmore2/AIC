// Setup API: everything a CEO configures for their own company — model providers and keys, which
// model each role uses, the technology stack, and database connections. Secret values go straight into
// the customer's vault; responses only ever carry fingerprints. Every change is a ledger command, so the
// policy engine (CEO/admin + fresh sign-in) and the audit trail apply.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { App } from '../app.js';
import type { Principal } from '../domain/types.js';
import { DomainError } from '../ledger/engine.js';
import { CONNECTION_KINDS, stackFrom, STACK_KEYS, type ConnectionKind, type Stack } from '../ledger/commands/setup.js';
import { checkConnection, DEFAULT_PORTS, type DbConfig } from '../connections/databases.js';
import { listProviderModels, ProviderError } from '../runtime/modelPort.js';
import { PRICES_CHECKED, PROVIDER_PRESETS } from '../runtime/presets.js';
import { SpendGuard } from '../runtime/spendGuard.js';
import { fingerprint } from '../secrets/vault.js';
import { inbox } from '../reports/views.js';

interface Helpers {
  who: (req: FastifyRequest) => Promise<Principal>;
  key: (req: FastifyRequest) => string;
  requireManager: (req: FastifyRequest) => Promise<Principal>;
}

const STACK_CHOICES: Record<string, string[]> = {
  language: ['TypeScript', 'JavaScript', 'Python', 'Go', 'Java', 'C#', 'Ruby', 'PHP'],
  framework: ['Express', 'Fastify', 'Next.js', 'NestJS', 'React', 'Vue', 'FastAPI', 'Django', 'Flask', 'Spring Boot', 'ASP.NET Core', 'Rails', 'Laravel', 'None'],
  database: ['PostgreSQL', 'MySQL', 'SQLite', 'MongoDB', 'None'],
  package_manager: ['npm', 'pnpm', 'yarn', 'pip', 'poetry', 'uv', 'go modules', 'maven', 'gradle'],
};

function dbConfig(kind: ConnectionKind, raw: Partial<DbConfig> | undefined): DbConfig {
  const host = String(raw?.host ?? '').trim();
  const database = String(raw?.database ?? '').trim();
  const user = String(raw?.user ?? '').trim();
  if (!host || !database || !user) throw new DomainError('validation', 'Host, database name and user are required');
  if (!/^[a-z0-9.\-_:[\]]+$/i.test(host)) throw new DomainError('validation', 'Host must be a hostname or IP address');
  const port = Number(raw?.port || DEFAULT_PORTS[kind]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DomainError('validation', 'Port must be between 1 and 65535');
  return { host, port, database, user, ssl: !!raw?.ssl };
}

export function registerSetupRoutes(server: FastifyInstance, app: App, h: Helpers) {
  const db = app.ledger.db;
  const settings = async () => (await db.query<{ settings: Record<string, string> }>('SELECT settings FROM company')).rows[0]?.settings ?? {};

  // ------------------------------------------------------------- overview: the setup checklist
  server.get('/api/setup', async (req) => {
    const me = await h.who(req);
    const role = (await db.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [me.id])).rows[0]?.role;
    const s = await settings();
    const models = app.models.profiles.filter((p) => p.provider !== 'scripted');
    const teams = Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM departments')).rows[0]!.n);
    const people = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM users WHERE email IS NOT NULL`)).rows[0]!.n);
    const conns = (await db.query<{ status: string }>(`SELECT status FROM connections`)).rows;
    const objectives = Number((await db.query<{ n: string }>('SELECT count(*) AS n FROM objectives')).rows[0]!.n);
    const stack = stackFrom(s);
    const steps = [
      { key: 'models', title: 'Connect an AI model', done: models.length > 0, detail: models.length ? `${models.length} model(s) ready` : 'Your employees think with a model you choose and pay for directly.' },
      { key: 'stack', title: 'Choose your tech stack', done: !!(stack.language || stack.framework || stack.database), detail: [stack.language, stack.framework, stack.database].filter(Boolean).join(' · ') || 'Language, framework and database your teams build with.' },
      { key: 'teams', title: 'Hire your first team', done: teams > 0, detail: teams ? `${teams} team(s) hired` : 'Pick a ready-made team or design your own.' },
      { key: 'people', title: 'Invite your people', done: people > 1, detail: people > 1 ? `${people} people can sign in` : 'Approvers and viewers sign in with Google.' },
      { key: 'brief', title: 'Brief a team lead', done: objectives > 0, detail: objectives ? `${objectives} objective(s)` : 'Tell a lead what you want; they come back with a plan.' },
    ];
    return {
      steps, role, default_model: s['default_model'] ?? app.config.models.default,
      spend_cap_usd: SpendGuard.fromEnv()?.capUsd ?? null,
      code_host: app.config.code_hosting.kind, sandbox: app.config.sandbox.kind,
      connections: { active: conns.filter((c) => c.status === 'active').length, requested: conns.filter((c) => c.status === 'requested').length },
      inbox: (await inbox(db)).length,
    };
  });

  // ------------------------------------------------------------- models and providers
  server.get('/api/providers/presets', async () => ({ prices_checked: PRICES_CHECKED, presets: PROVIDER_PRESETS }));

  server.get('/api/models', async (req) => {
    await h.who(req);
    const providers = (await db.query(`SELECT id, kind, label, api, base_url, key_fingerprint, created_at FROM model_providers WHERE status = 'active' ORDER BY created_at`)).rows;
    const added = new Map((await db.query<{ key: string; provider_id: string }>(`SELECT key, provider_id FROM model_profiles WHERE status = 'active'`)).rows.map((r) => [r.key, r.provider_id]));
    const usage = new Map((await db.query<{ model_profile: string; n: string }>(`SELECT model_profile, count(*) AS n FROM employees WHERE status = 'active' GROUP BY model_profile`)).rows.map((r) => [r.model_profile, Number(r.n)]));
    const guard = SpendGuard.fromEnv();
    return {
      default_model: (await settings())['default_model'] ?? app.config.models.default,
      providers,
      models: app.models.profiles.map((p) => ({
        key: p.key, model: p.model, provider: p.provider, family: p.family, price_per_million: p.price_per_million, context_tokens: p.context_tokens,
        source: added.has(p.key) ? 'dashboard' : 'config', provider_id: added.get(p.key) ?? null, employees: usage.get(p.key) ?? 0,
        spent_usd: guard && p.provider !== 'scripted' ? guard.spent(SpendGuard.keyId(p, app.models.secretLookup)) : null,
      })),
      spend_cap_usd: guard?.capUsd ?? null,
    };
  });

  /** Check a key for free (lists the provider's models), store it in the vault, record the provider. */
  server.post<{ Body: { kind: string; label?: string; base_url?: string; api_key?: string } }>('/api/providers', async (req) => {
    const p = await h.requireManager(req);
    const preset = PROVIDER_PRESETS.find((x) => x.kind === req.body?.kind);
    if (!preset) throw new DomainError('validation', 'Choose a provider');
    const baseUrl = (req.body.base_url?.trim() || preset.base_url)?.replace(/\/$/, '');
    if (!baseUrl && preset.api === 'openai_compatible') throw new DomainError('validation', 'This provider needs a base URL');
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new DomainError('validation', 'The base URL must start with http:// or https://');
    const apiKey = req.body.api_key?.trim() ?? '';
    if (preset.needs_key && apiKey.length < 8) throw new DomainError('validation', `Paste your ${preset.name} API key`);
    let available: string[] = [];
    try { available = await listProviderModels(preset.api, baseUrl, apiKey); } catch (e) {
      throw new DomainError('validation', e instanceof ProviderError ? e.message : `Could not verify the key: ${(e as Error).message}`);
    }
    const secretId = apiKey ? app.vault.put(apiKey, `${preset.name} API key`) : undefined;
    try {
      const r = await app.ledger.run('addModelProvider', { kind: preset.kind, label: req.body.label?.trim() || preset.name, api: preset.api, baseUrl,
        secretId, keyFingerprint: apiKey ? fingerprint(apiKey) : undefined }, p, h.key(req));
      return { providerId: r.providerId, available: available.slice(0, 300) };
    } catch (e) { if (secretId) app.vault.delete(secretId); throw e; }
  });

  server.post<{ Params: { id: string } }>('/api/providers/:id/remove', async (req) => {
    const r = await app.ledger.run('removeModelProvider', { providerId: req.params.id }, await h.requireManager(req), h.key(req));
    if (r.secretId) app.vault.delete(r.secretId);
    await app.models.refresh(db);
    return { ok: true };
  });

  server.post<{ Body: { provider_id: string; key?: string; model: string; family?: string; input_price: number; output_price: number; context_tokens?: number } }>('/api/models', async (req) => {
    const p = await h.requireManager(req);
    const prov = (await db.query<{ kind: string }>(`SELECT kind FROM model_providers WHERE id = $1 AND status = 'active'`, [req.body?.provider_id])).rows[0];
    if (!prov) throw new DomainError('not_found', 'Provider not found');
    const preset = PROVIDER_PRESETS.find((x) => x.kind === prov.kind)!;
    const model = String(req.body.model ?? '').trim();
    if (!model) throw new DomainError('validation', 'Choose a model');
    const key = (req.body.key?.trim() || model).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 41);
    if (app.models.profiles.some((x) => x.key === key)) throw new DomainError('conflict', `A model named "${key}" already exists`);
    const known = preset.models.find((m) => m.model === model);
    const r = await app.ledger.run('addModelProfile', { providerId: req.body.provider_id, profile: {
      key, model, family: req.body.family?.trim() || preset.family, context_tokens: Number(req.body.context_tokens) || known?.context || 128_000,
      structured_output: true, tool_calling: true, price_per_million: { input: Number(req.body.input_price) || 0, output: Number(req.body.output_price) || 0 },
    } }, p, h.key(req));
    await app.models.refresh(db);
    return r;
  });

  server.post<{ Body: { key: string } }>('/api/models/default', async (req) => {
    const known = app.models.profiles.some((x) => x.key === req.body?.key);
    return app.ledger.run('setDefaultModel', { key: req.body?.key, known }, await h.requireManager(req), h.key(req));
  });

  server.post<{ Params: { dept: string; role: string }; Body: { key: string } }>('/api/teams/:dept/roles/:role/model', async (req) => {
    const prof = app.models.profiles.find((x) => x.key === req.body?.key);
    if (!prof) throw new DomainError('not_found', `Model "${req.body?.key}" is not configured`);
    return app.ledger.run('assignRoleModel', { departmentKey: req.params.dept, roleKey: req.params.role, profile: prof }, await h.requireManager(req), h.key(req));
  });

  server.get('/api/roles', async (req) => {
    await h.who(req);
    return (await db.query(`SELECT d.key AS department, d.name AS department_name, e.role_key AS role, min(e.role_snapshot->>'title') AS title, min(e.category) AS category,
      min(e.model_profile) AS model, count(*)::int AS seats FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.status = 'active'
      GROUP BY d.key, d.name, e.role_key ORDER BY d.name, min(e.category), e.role_key`)).rows;
  });

  // ------------------------------------------------------------- tech stack
  server.get('/api/stack', async (req) => { await h.who(req); return { stack: stackFrom(await settings()), choices: STACK_CHOICES, keys: STACK_KEYS }; });
  server.post<{ Body: { stack: Stack } }>('/api/stack', async (req) =>
    app.ledger.run('setStack', { stack: req.body?.stack ?? {} }, await h.requireManager(req), h.key(req)));

  // ------------------------------------------------------------- connections (databases)
  server.get('/api/connections', async (req) => {
    await h.requireManager(req);
    return (await db.query(`SELECT c.id, c.kind, c.name, c.purpose, c.status, c.access, c.config, c.key_fingerprint, c.last_check, c.created_at, c.task_id,
      d.name AS team, d.key AS team_key, e.display_name AS requested_by, t.title AS task_title
      FROM connections c LEFT JOIN departments d ON d.id = c.department_id LEFT JOIN employees e ON e.id = c.requested_by_employee_id
      LEFT JOIN tasks t ON t.id = c.task_id WHERE c.status <> 'revoked' ORDER BY (c.status = 'requested') DESC, c.created_at DESC`)).rows;
  });

  /** Try credentials without saving anything (so the CEO sees "connected ✓" before committing). */
  server.post<{ Body: { kind: ConnectionKind; config: Partial<DbConfig>; password: string } }>('/api/connections/test', async (req) => {
    await h.requireManager(req);
    const kind = req.body?.kind;
    if (!CONNECTION_KINDS.includes(kind)) throw new DomainError('validation', 'Choose PostgreSQL or MySQL');
    try { return await checkConnection(kind, dbConfig(kind, req.body.config), String(req.body.password ?? '')); }
    catch (e) { if (e instanceof DomainError) throw e; return { ok: false, error: (e as Error).message.slice(0, 300) }; }
  });

  /** Provide credentials for a request (or add a new connection): live check → vault → ledger command. */
  server.post<{ Body: { connection_id?: string; kind?: ConnectionKind; name?: string; purpose?: string; team?: string; config: Partial<DbConfig>; password: string; access: 'read' | 'read_write' } }>('/api/connections', async (req) => {
    const p = await h.requireManager(req);
    let kind = req.body?.kind;
    if (req.body?.connection_id) {
      kind = (await db.query<{ kind: ConnectionKind }>('SELECT kind FROM connections WHERE id = $1', [req.body.connection_id])).rows[0]?.kind;
      if (!kind) throw new DomainError('not_found', 'Connection not found');
    }
    if (!kind || !CONNECTION_KINDS.includes(kind)) throw new DomainError('validation', 'Choose PostgreSQL or MySQL');
    const cfg = dbConfig(kind, req.body.config);
    const password = String(req.body.password ?? '');
    let check;
    try { check = await checkConnection(kind, cfg, password); }
    catch (e) { throw new DomainError('validation', `Could not connect: ${(e as Error).message.slice(0, 300)}`); }
    const access = req.body.access === 'read_write' ? 'read_write' : 'read';
    const secretId = app.vault.put(password, `${kind} ${cfg.user}@${cfg.host}/${cfg.database}`);
    try {
      const r = await app.ledger.run('provideConnection', { connectionId: req.body.connection_id, kind, name: req.body.name, purpose: req.body.purpose, departmentKey: req.body.team || undefined,
        config: cfg, access, secretId, keyFingerprint: `${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`, check }, p, h.key(req));
      if (r.previousSecretId) app.vault.delete(r.previousSecretId);
      return { connectionId: r.connectionId, check };
    } catch (e) { app.vault.delete(secretId); throw e; }
  });

  server.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/connections/:id/decline', async (req) =>
    app.ledger.run('declineConnection', { connectionId: req.params.id, reason: req.body?.reason ?? '' }, await h.requireManager(req), h.key(req)));

  server.post<{ Params: { id: string } }>('/api/connections/:id/revoke', async (req) => {
    const r = await app.ledger.run('revokeConnection', { connectionId: req.params.id }, await h.requireManager(req), h.key(req));
    if (r.secretId) app.vault.delete(r.secretId);
    return { ok: true };
  });
}
