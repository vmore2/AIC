// Local API + CEO dashboard (architecture.md §14–15, MVP subset). Binds to localhost and requires a
// per-session token. Commands go through the Transition Engine exactly like the CLI; there is no
// endpoint that sets task status directly (§14.8).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { App } from '../app.js';
import { type Mode, type Principal } from '../domain/types.js';
import { newId } from '../domain/ids.js';
import { DomainError, verifyChain } from '../ledger/engine.js';
import { inbox, objectiveRollups, orgChart, taskDetail } from '../reports/views.js';
import { registerTeamRoutes } from './teams.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

export async function startServer(app: App, port = 4100, host = '127.0.0.1') {
  const token = process.env['AIC_DASHBOARD_TOKEN'] ?? randomBytes(18).toString('base64url');
  const server = buildServer(app, token);
  return server;
}

/** The HTTP app without listening (used by startServer and tests). */
export function buildServer(app: App, token: string) {
  const server = Fastify({ logger: false });
  const db = app.ledger.db;

  const ceo = async (): Promise<Principal> => {
    const u = (await db.query<{ id: string }>(`SELECT id FROM users WHERE role = 'ceo' LIMIT 1`)).rows[0];
    if (!u) throw new DomainError('not_found', 'Company not initialized');
    return { type: 'user', id: u.id, stepUp: true };
  };
  const authed = (req: FastifyRequest) => {
    const given = String(req.headers['x-aic-token'] ?? '');
    return given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
  };
  const key = (req: FastifyRequest) => String(req.headers['idempotency-key'] ?? newId('http'));

  server.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/') && !authed(req)) return reply.code(401).send({ type: 'unauthenticated', title: 'Missing or invalid dashboard token' });
  });
  server.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      const status = { forbidden: 403, stale_lease: 403, not_found: 404, guard_failed: 409, conflict: 409, budget_exhausted: 409, validation: 400, idempotency_key_reuse: 422, precondition_failed: 412 }[err.code] ?? 400;
      return reply.code(status).type('application/problem+json').send({ type: err.code, title: err.message, status, ...err.details });
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

  // ---- commands (CEO)
  server.post<{ Params: { id: string }; Body: { decision: 'approve' | 'request_changes'; rationale?: string } }>('/api/proposals/:id/decision', async (req) =>
    app.ledger.run('decideProposal', { proposalId: req.params.id, decision: req.body.decision, rationale: req.body.rationale }, await ceo(), key(req)));
  server.post<{ Params: { id: string }; Body: { rationale?: string } }>('/api/tasks/:id/accept', async (req) => {
    const sub = (await db.query<{ submission_sha256: string }>(`SELECT submission_sha256 FROM submissions WHERE task_id = $1 AND status = 'open'`, [req.params.id])).rows[0];
    if (!sub) throw new DomainError('guard_failed', 'No open submission');
    return app.ledger.run('acceptTask', { taskId: req.params.id, submissionSha256: sub.submission_sha256, rationale: req.body?.rationale }, await ceo(), key(req));
  });
  server.post<{ Params: { id: string }; Body: { rationale: string } }>('/api/tasks/:id/reject', async (req) =>
    app.ledger.run('rejectTask', { taskId: req.params.id, rationale: req.body.rationale }, await ceo(), key(req)));
  server.post<{ Params: { id: string }; Body: { answer: string } }>('/api/escalations/:id/resolve', async (req) =>
    app.ledger.run('resolveEscalation', { escalationId: req.params.id, answer: req.body.answer }, await ceo(), key(req)));
  server.post<{ Params: { id: string } }>('/api/directives/:id/confirm', async (req) => {
    const d = (await db.query<{ payload_sha256: string }>('SELECT payload_sha256 FROM directives WHERE id = $1', [req.params.id])).rows[0];
    if (!d) throw new DomainError('not_found', 'Directive not found');
    return app.ledger.run('confirmDirective', { directiveId: req.params.id, payloadSha256: d.payload_sha256 }, await ceo(), key(req));
  });
  server.post<{ Params: { id: string }; Body: { reason?: string } }>('/api/directives/:id/decline', async (req) =>
    app.ledger.run('rejectDirective', { directiveId: req.params.id, reason: req.body?.reason ?? 'declined' }, await ceo(), key(req)));
  server.post<{ Body: { employee: string; message: string } }>('/api/chat', async (req) => {
    const emp = (await db.query<{ id: string; display_name: string }>(`SELECT id, display_name FROM employees WHERE id = $1 OR role_key = $1 ORDER BY created_at LIMIT 1`, [req.body.employee])).rows[0];
    if (!emp) throw new DomainError('not_found', 'Employee not found');
    const principal = await ceo();
    const existing = (await db.query<{ id: string }>('SELECT id FROM conversations WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1', [emp.id])).rows[0];
    const conversationId = existing?.id ?? (await app.ledger.run('startConversation', { employeeId: emp.id }, principal)).conversationId;
    const { runId } = await app.ledger.run('postMessage', { conversationId, body: req.body.message }, principal, key(req));
    return { employee: emp.display_name, ...(await app.orchestrator.converse(runId)) };
  });
  server.post<{ Body: { reason: string } }>('/api/emergency-stop', async (req) =>
    app.ledger.run('emergencyStop', { scope: { type: 'company', id: (await db.query<{ id: string }>('SELECT id FROM company')).rows[0]!.id }, reason: req.body.reason || 'dashboard emergency stop' }, await ceo(), key(req)));
  server.post<{ Body: { mode?: Mode; ack?: boolean; reason?: string } }>('/api/resume', async (req) =>
    app.ledger.run('resumeScope', { scope: { type: 'company', id: (await db.query<{ id: string }>('SELECT id FROM company')).rows[0]!.id },
      mode: req.body.mode ?? app.config.defaults.mode, acknowledgeUnresolvedActions: !!req.body.ack, reason: req.body.reason ?? 'resume' }, await ceo(), key(req)));
  registerTeamRoutes(server, app, ceo);
  server.post<{ Params: { id: string } }>('/api/objectives/:id/release', async (req) => {
    const sha = await app.workspaces.remoteSha(`refs/heads/${app.workspaces.integrationBranch(req.params.id)}`);
    if (!sha) throw new DomainError('not_found', 'No integration branch');
    return app.ledger.run('approveRelease', { objectiveId: req.params.id, integrationSha: sha }, await ceo(), key(req));
  });

  return server;
}
