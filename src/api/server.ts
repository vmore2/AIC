// Local API + CEO dashboard (architecture.md §14–15, MVP subset). Binds to localhost and requires a
// per-session token. Commands go through the Transition Engine exactly like the CLI; there is no
// endpoint that sets task status directly (§14.8).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { App } from '../app.js';
import { SYSTEM, type Mode, type Principal } from '../domain/types.js';
import { newId } from '../domain/ids.js';
import { DomainError, verifyChain } from '../ledger/engine.js';
import { sha256Hex } from '../domain/hash.js';
import { inbox, objectiveRollups, orgChart, taskDetail } from '../reports/views.js';
import { registerTeamRoutes } from './teams.js';
import { GoogleAuth, sessionSecret } from './auth.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

export async function startServer(app: App, port = 4100, host = '127.0.0.1') {
  const token = process.env['AIC_DASHBOARD_TOKEN'] ?? randomBytes(18).toString('base64url');
  const g = app.config.auth.google;
  let google: GoogleAuth | undefined;
  if (g) {
    const clientSecret = process.env[g.client_secret_env];
    if (!clientSecret) throw new Error(`Google sign-in is configured but ${g.client_secret_env} is not set (put it in .env)`);
    google = new GoogleAuth({ clientId: g.client_id, clientSecret, publicUrl: g.public_url, allowedDomain: g.allowed_domain,
      sessionSecret: sessionSecret(app.config.storage_path, process.env[app.config.auth.session_secret_env]) }, app.ledger.db);
  }
  const server = buildServer(app, token, { google });
  await app.orchestrator.recoverOrphans();
  app.orchestrator.start(750);
  await server.listen({ port, host });
  console.log(`Dashboard: http://${host}:${port}/#token=${token}`);
  console.log('This owner token acts as the CEO. Give teammates their own tokens with `aic users add`.');
  if (google) console.log(`Google sign-in: ${google.cfg.publicUrl} (people need an email on file: aic users email <id|ceo> <email>)`);
  return server;
}

/** The HTTP app without listening (used by startServer and tests). */
export function buildServer(app: App, token: string, opts: { google?: GoogleAuth } = {}) {
  const server = Fastify({ logger: false });
  const db = app.ledger.db;
  // Keep the raw JSON body (needed to verify webhook signatures), then parse it ourselves.
  server.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = String(body);
    try { done(null, body ? JSON.parse(String(body)) : {}); } catch (e) { done(e as Error, undefined); }
  });

  // Who is calling: the owner token (the CEO's own session, step-up) or a personal access token.
  // Roles are enforced by the policy engine on every command, not by this layer.
  const principals = new WeakMap<FastifyRequest, Principal>();
  const viaCookie = new WeakSet<FastifyRequest>();
  const resolve = async (req: FastifyRequest): Promise<Principal | null> => {
    const given = String(req.headers['x-aic-token'] ?? '');
    if (!given) {
      const p = opts.google ? await opts.google.principalFrom(req) : null;
      if (p) viaCookie.add(req);
      return p;
    }
    if (given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token))) {
      const u = (await db.query<{ id: string }>(`SELECT id FROM users WHERE role = 'ceo' LIMIT 1`)).rows[0];
      return u ? { type: 'user', id: u.id, stepUp: true } : null;
    }
    const t = (await db.query<{ id: string; user_id: string }>(
      `SELECT a.id, a.user_id FROM access_tokens a JOIN users u ON u.id = a.user_id WHERE a.token_sha256 = $1 AND a.revoked_at IS NULL`, [sha256Hex(given)])).rows[0];
    if (!t) return null;
    await db.query('UPDATE access_tokens SET last_used_at = now() WHERE id = $1', [t.id]);
    return { type: 'user', id: t.user_id, stepUp: false };
  };
  const who = async (req: FastifyRequest): Promise<Principal> => {
    const p = principals.get(req);
    if (!p) throw new DomainError('forbidden', 'Not signed in');
    return p;
  };
  const key = (req: FastifyRequest) => String(req.headers['idempotency-key'] ?? newId('http'));

  server.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/hooks/') || req.url === '/api/auth/config') return;
    const p = await resolve(req);
    if (!p) return reply.code(401).send({ type: 'unauthenticated', title: 'Not signed in', google: !!opts.google });
    // Cookie sessions: writes must come from the dashboard's own script (CSRF defense; no CORS is enabled).
    if (viaCookie.has(req) && !['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'aic')
      return reply.code(403).send({ type: 'forbidden', title: 'Missing x-requested-with header' });
    principals.set(req, p);
  });
  opts.google?.register(server);
  server.get('/api/auth/config', async () => ({ google: !!opts.google }));
  server.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      const status = { forbidden: 403, stale_lease: 403, not_found: 404, guard_failed: 409, conflict: 409, budget_exhausted: 409, validation: 400, idempotency_key_reuse: 422, precondition_failed: 412 }[err.code] ?? 400;
      // A Google session that isn't fresh enough for a governance action: tell the dashboard how to re-verify.
      const stepUp = err.code === 'forbidden' && viaCookie.has(req) && !principals.get(req)?.stepUp ? { step_up_url: '/auth/google?stepup=1' } : {};
      return reply.code(status).type('application/problem+json').send({ type: err.code, title: err.message, status, ...err.details, ...stepUp });
    }
    return reply.code(500).send({ type: 'internal', title: (err as Error).message });
  });

  server.get('/', async (_req, reply: FastifyReply) => reply.type('text/html').send(readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')));

  // ---- queries (derived views computed from the ledger)
  server.get('/api/status', async () => ({ company: (await db.query('SELECT name FROM company')).rows[0], objectives: await objectiveRollups(db), activeRuns: app.orchestrator.activeRuns }));
  server.get('/api/inbox', async () => inbox(db));
  server.get('/api/team', async () => orgChart(db));
  server.get<{ Params: { id: string } }>('/api/tasks/:id', async (req) => taskDetail(db, req.params.id));
  server.get<{ Params: { id: string } }>('/api/proposals/:id', async (req) => (await db.query('SELECT * FROM proposals WHERE id = $1', [req.params.id])).rows[0] ?? null);
  server.get<{ Params: { id: string } }>('/api/directives/:id', async (req) => (await db.query('SELECT * FROM directives WHERE id = $1', [req.params.id])).rows[0] ?? null);
  server.get<{ Querystring: { objective?: string } }>('/api/tasks', async (req) =>
    (await db.query(`SELECT t.id, t.title, t.kind, t.status, t.hold, t.attempt, t.assurance_label, e.display_name AS owner, t.objective_id
                     FROM tasks t LEFT JOIN employees e ON e.id = t.owner_employee_id ${req.query.objective ? 'WHERE t.objective_id = $1' : ''} ORDER BY t.created_at`,
      req.query.objective ? [req.query.objective] : [])).rows);
  server.get('/api/events', async () => (await db.query('SELECT seq, type, aggregate_id, actor, payload, occurred_at FROM ledger_events ORDER BY seq DESC LIMIT 60')).rows);
  server.get('/api/audit', async () => verifyChain(db));
  // CI webhook: authenticated by an HMAC signature over the raw body (set AIC_CI_WEBHOOK_SECRET in CI and here).
  server.post('/api/hooks/ci', { config: { rawBody: true } }, async (req, reply) => {
    const secret = process.env['AIC_CI_WEBHOOK_SECRET'];
    if (!secret) return reply.code(503).send({ type: 'not_configured', title: 'Set AIC_CI_WEBHOOK_SECRET to enable the CI webhook' });
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
    const given = String(req.headers['x-aic-signature'] ?? '');
    if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return reply.code(401).send({ type: 'bad_signature', title: 'Invalid signature' });
    const b = JSON.parse(raw) as { sha: string; status: 'success' | 'failure'; name: string; url?: string; branch?: string; delivery_id?: string };
    const r = await app.ledger.run('recordCiResult', { sha: b.sha, status: b.status, name: b.name, url: b.url, branch: b.branch }, SYSTEM, `ci:${b.delivery_id ?? `${b.sha}:${b.name}:${b.status}`}`);
    return r;
  });
  server.post<{ Params: { id: string }; Body: { decision: 'approve' | 'reject'; reason?: string } }>('/api/notes/:id', async (req) =>
    app.ledger.run('curateNote', { noteId: req.params.id, decision: req.body.decision, reason: req.body.reason }, await who(req), key(req)));
  server.get('/api/me', async (req) => {
    const p = await who(req);
    const u = (await db.query<{ name: string; role: string }>('SELECT name, role FROM users WHERE id = $1', [p.id])).rows[0];
    return { id: p.id, name: u?.name, role: u?.role, owner: !!p.stepUp, auth: viaCookie.has(req) ? 'google' : 'token' };
  });

  // ---- commands (CEO)
  server.post<{ Params: { id: string }; Body: { decision: 'approve' | 'request_changes'; rationale?: string } }>('/api/proposals/:id/decision', async (req) =>
    app.ledger.run('decideProposal', { proposalId: req.params.id, decision: req.body.decision, rationale: req.body.rationale }, await who(req), key(req)));
  server.post<{ Params: { id: string }; Body: { rationale?: string } }>('/api/tasks/:id/accept', async (req) => {
    const sub = (await db.query<{ submission_sha256: string }>(`SELECT submission_sha256 FROM submissions WHERE task_id = $1 AND status = 'open'`, [req.params.id])).rows[0];
    if (!sub) throw new DomainError('guard_failed', 'No open submission');
    return app.ledger.run('acceptTask', { taskId: req.params.id, submissionSha256: sub.submission_sha256, rationale: req.body?.rationale }, await who(req), key(req));
  });
  server.post<{ Params: { id: string }; Body: { rationale: string } }>('/api/tasks/:id/reject', async (req) =>
    app.ledger.run('rejectTask', { taskId: req.params.id, rationale: req.body.rationale }, await who(req), key(req)));
  server.post<{ Params: { id: string }; Body: { answer: string } }>('/api/escalations/:id/resolve', async (req) =>
    app.ledger.run('resolveEscalation', { escalationId: req.params.id, answer: req.body.answer }, await who(req), key(req)));
  server.post<{ Params: { id: string } }>('/api/directives/:id/confirm', async (req) => {
    const d = (await db.query<{ payload_sha256: string }>('SELECT payload_sha256 FROM directives WHERE id = $1', [req.params.id])).rows[0];
    if (!d) throw new DomainError('not_found', 'Directive not found');
    return app.ledger.run('confirmDirective', { directiveId: req.params.id, payloadSha256: d.payload_sha256 }, await who(req), key(req));
  });
  server.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/directives/:id/decline', async (req) =>
    app.ledger.run('rejectDirective', { directiveId: req.params.id, reason: req.body?.reason ?? 'declined' }, await who(req), key(req)));
  server.post<{ Body: { employee: string; message: string } }>('/api/chat', async (req) => {
    const emp = (await db.query<{ id: string; display_name: string }>(`SELECT id, display_name FROM employees WHERE id = $1 OR role_key = $1 ORDER BY created_at LIMIT 1`, [req.body.employee])).rows[0];
    if (!emp) throw new DomainError('not_found', 'Employee not found');
    const principal = await who(req);
    const existing = (await db.query<{ id: string }>('SELECT id FROM conversations WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1', [emp.id])).rows[0];
    const conversationId = existing?.id ?? (await app.ledger.run('startConversation', { employeeId: emp.id }, principal)).conversationId;
    const { runId } = await app.ledger.run('postMessage', { conversationId, body: req.body.message }, principal, key(req));
    return { employee: emp.display_name, ...(await app.orchestrator.converse(runId)) };
  });
  server.post<{ Body: { reason: string } }>('/api/emergency-stop', async (req) =>
    app.ledger.run('emergencyStop', { scope: { type: 'company', id: (await db.query<{ id: string }>('SELECT id FROM company')).rows[0]!.id }, reason: req.body.reason || 'dashboard emergency stop' }, await who(req), key(req)));
  server.post<{ Body: { mode?: Mode; ack?: boolean; reason?: string } }>('/api/resume', async (req) =>
    app.ledger.run('resumeScope', { scope: { type: 'company', id: (await db.query<{ id: string }>('SELECT id FROM company')).rows[0]!.id },
      mode: req.body.mode ?? app.config.defaults.mode, acknowledgeUnresolvedActions: !!req.body.ack, reason: req.body.reason ?? 'resume' }, await who(req), key(req)));
  registerTeamRoutes(server, app, who);
  server.post<{ Params: { id: string }; Body: { employeeId: string; reason: string } }>('/api/tasks/:id/reassign', async (req) =>
    app.ledger.run('reassignTask', { taskId: req.params.id, employeeId: req.body.employeeId, reason: req.body.reason }, await who(req), key(req)));
  server.get<{ Params: { id: string } }>('/api/tasks/:id/candidates', async (req) =>
    (await db.query(`SELECT e.id, e.display_name, e.role_key FROM employees e JOIN tasks t ON t.id = $1 JOIN employees o ON o.id = t.owner_employee_id
                     WHERE e.department_id = o.department_id AND e.status = 'active' AND e.category <> 'reviewer' AND e.id <> t.owner_employee_id
                       AND e.role_snapshot->'task_kinds' ? t.kind ORDER BY e.display_name`, [req.params.id])).rows);
  server.get<{ Params: { id: string } }>('/api/objectives/:id/requirements', async (req) =>
    (await db.query(`SELECT r.key, r.current_version AS version, rv.text FROM requirements r JOIN requirement_versions rv ON rv.requirement_id = r.id AND rv.version = r.current_version
                     WHERE r.objective_id = $1 AND r.status = 'active' ORDER BY r.key`, [req.params.id])).rows);
  server.post<{ Params: { id: string }; Body: { key: string; text: string; reason: string } }>('/api/objectives/:id/requirements', async (req) =>
    app.ledger.run('changeRequirement', { objectiveId: req.params.id, key: req.body.key, text: req.body.text, reason: req.body.reason || 'changed by CEO' }, await who(req), key(req)));
  server.get('/api/doctor', async () => (await import('../ops/doctor.js')).runDoctor(app));
  server.post<{ Params: { id: string } }>('/api/objectives/:id/release', async (req) => {
    const sha = await app.workspaces.remoteSha(`refs/heads/${app.workspaces.integrationBranch(req.params.id)}`);
    if (!sha) throw new DomainError('not_found', 'No integration branch');
    return app.ledger.run('approveRelease', { objectiveId: req.params.id, integrationSha: sha }, await who(req), key(req));
  });

  return server;
}
