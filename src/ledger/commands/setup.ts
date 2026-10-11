// CEO-managed setup (the service is configured by each CEO, not by us): model providers and keys,
// which model each role uses, the project's technology stack, and connections (databases) that
// employees request and the CEO provides. Secret values never enter the ledger — callers store them in
// the customer's vault first and pass only the vault id and a fingerprint.
import { newId } from '../../domain/ids.js';
import { ModelProfileSchema, type ModelProfile } from '../../config/config.js';
import type { Role } from '../../org/schema.js';
import { DomainError, type Handler } from '../engine.js';
import { getEmployee, getObjective, getTask } from '../store.js';
import { transitionTask } from '../transition.js';
import { capabilityGaps } from './org.js';
import { ownerContext, resolveEscalation } from './work.js';

export const PROVIDER_KINDS = ['openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'ollama', 'custom'] as const;

export const addModelProvider: Handler<{ kind: (typeof PROVIDER_KINDS)[number]; label: string; api: 'openai_compatible' | 'anthropic'; baseUrl?: string; secretId?: string; keyFingerprint?: string }, { providerId: string }> =
  async (c, i) => {
    await c.authorize('company.configure', { type: 'Company', id: 'company' }, { action_class: 'A6' });
    if (!PROVIDER_KINDS.includes(i.kind)) throw new DomainError('validation', `Unknown provider kind ${i.kind}`);
    if (!i.label.trim()) throw new DomainError('validation', 'Give the provider a name');
    const providerId = newId('prv');
    await c.q.query(`INSERT INTO model_providers (id, kind, label, api, base_url, secret_id, key_fingerprint, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [providerId, i.kind, i.label.trim(), i.api, i.baseUrl ?? null, i.secretId ?? null, i.keyFingerprint ?? null, c.principal.id]);
    c.emit({ type: 'model_provider.added', aggregateType: 'company', aggregateId: providerId, payload: { kind: i.kind, label: i.label, base_url: i.baseUrl ?? null, key: i.keyFingerprint ?? null } });
    return { providerId };
  };

export const removeModelProvider: Handler<{ providerId: string }, { secretId: string | null }> = async (c, i) => {
  await c.authorize('company.configure', { type: 'Company', id: 'company' }, { action_class: 'A6' });
  const p = (await c.q.query<{ secret_id: string | null }>(`SELECT secret_id FROM model_providers WHERE id = $1 AND status = 'active'`, [i.providerId])).rows[0];
  if (!p) throw new DomainError('not_found', 'Provider not found');
  const inUse = (await c.q.query<{ display_name: string }>(
    `SELECT e.display_name FROM employees e JOIN model_profiles m ON m.key = e.model_profile WHERE m.provider_id = $1 AND e.status = 'active' LIMIT 3`, [i.providerId])).rows;
  if (inUse.length) throw new DomainError('guard_failed', `Employees still use this provider's models (${inUse.map((r) => r.display_name).join(', ')}…). Assign them other models first.`);
  await c.q.query(`UPDATE model_providers SET status = 'removed' WHERE id = $1`, [i.providerId]);
  await c.q.query(`UPDATE model_profiles SET status = 'removed' WHERE provider_id = $1`, [i.providerId]);
  c.emit({ type: 'model_provider.removed', aggregateType: 'company', aggregateId: i.providerId, payload: {} });
  return { secretId: p.secret_id };
};

/** Add a model the company may use. The key comes from the provider row, never from the caller. */
export const addModelProfile: Handler<{ providerId: string; profile: Omit<ModelProfile, 'provider' | 'base_url' | 'api_key_env' | 'api_key_secret'> }, { key: string }> =
  async (c, i) => {
    await c.authorize('company.configure', { type: 'Company', id: 'company' }, { action_class: 'A6' });
    const prov = (await c.q.query<{ api: 'openai_compatible' | 'anthropic'; base_url: string | null; secret_id: string | null }>(
      `SELECT api, base_url, secret_id FROM model_providers WHERE id = $1 AND status = 'active'`, [i.providerId])).rows[0];
    if (!prov) throw new DomainError('not_found', 'Provider not found');
    const parsed = ModelProfileSchema.safeParse({ ...i.profile, provider: prov.api, ...(prov.base_url ? { base_url: prov.base_url } : {}), ...(prov.secret_id ? { api_key_secret: prov.secret_id } : {}) });
    if (!parsed.success) throw new DomainError('validation', parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '));
    if (!/^[a-z0-9][a-z0-9._-]{1,40}$/i.test(parsed.data.key)) throw new DomainError('validation', 'Model key: letters, digits, dot, dash or underscore (2–41 characters)');
    if ((await c.q.query('SELECT 1 FROM model_profiles WHERE key = $1', [parsed.data.key])).rows.length) throw new DomainError('conflict', `A model named "${parsed.data.key}" already exists`);
    await c.q.query(`INSERT INTO model_profiles (key, provider_id, profile, created_by) VALUES ($1,$2,$3,$4)`, [parsed.data.key, i.providerId, JSON.stringify(parsed.data), c.principal.id]);
    c.emit({ type: 'model_profile.added', aggregateType: 'company', aggregateId: parsed.data.key,
      payload: { provider_id: i.providerId, model: parsed.data.model, family: parsed.data.family, price_per_million: parsed.data.price_per_million } });
    return { key: parsed.data.key };
  };

/** Put every employee in a role on a model (governance). Runs already in flight finish on their model. */
export const assignRoleModel: Handler<{ departmentKey: string; roleKey: string; profile: ModelProfile }, { employees: number }> = async (c, i) => {
  await c.authorize('employee.reconfigure', { type: 'Department', id: i.departmentKey }, { action_class: 'A6' });
  const emps = (await c.q.query<{ id: string; role_snapshot: Role; category: string }>(
    `SELECT e.id, e.role_snapshot, e.category FROM employees e JOIN departments d ON d.id = e.department_id
     WHERE d.key = $1 AND e.role_key = $2 AND e.status = 'active'`, [i.departmentKey, i.roleKey])).rows;
  if (!emps.length) throw new DomainError('not_found', `No active ${i.roleKey} in ${i.departmentKey}`);
  const gaps = capabilityGaps(emps[0]!.role_snapshot, i.profile);
  if (gaps.length) throw new DomainError('validation', `"${i.profile.key}" can't serve this role: missing ${gaps.join(', ')}`);
  await c.q.query(`UPDATE employees SET model_profile = $3, model_family = $4, version = version + 1
                   WHERE role_key = $2 AND status = 'active' AND department_id = (SELECT id FROM departments WHERE key = $1)`,
    [i.departmentKey, i.roleKey, i.profile.key, i.profile.family]);
  c.emit({ type: 'employee.model_changed', aggregateType: 'department', aggregateId: i.departmentKey,
    payload: { role: i.roleKey, model_profile: i.profile.key, model_family: i.profile.family, employees: emps.length } });
  return { employees: emps.length };
};

/** The model new hires get unless a role is given one explicitly. */
export const setDefaultModel: Handler<{ key: string; known: boolean }, { key: string }> = async (c, i) => {
  await c.authorize('company.configure', { type: 'Company', id: 'company' }, { action_class: 'A6' });
  if (!i.known) throw new DomainError('not_found', `Model "${i.key}" is not configured`);
  const row = (await c.q.query<{ id: string; settings: Record<string, string> }>('SELECT id, settings FROM company')).rows[0];
  if (!row) throw new DomainError('not_found', 'No company');
  await c.q.query('UPDATE company SET settings = $2 WHERE id = $1', [row.id, JSON.stringify({ ...row.settings, default_model: i.key })]);
  c.emit({ type: 'company.default_model_set', aggregateType: 'company', aggregateId: row.id, payload: { key: i.key } });
  return { key: i.key };
};

export const STACK_KEYS = ['language', 'framework', 'database', 'package_manager', 'test_command', 'notes'] as const;
export type Stack = Partial<Record<(typeof STACK_KEYS)[number], string>>;

/** The technology choices every task contract carries as constraints. */
export const setStack: Handler<{ stack: Stack }, { stack: Stack }> = async (c, i) => {
  await c.authorize('company.configure', { type: 'Company', id: 'company' }, { action_class: 'A6' });
  const clean: Stack = {};
  for (const k of STACK_KEYS) { const v = i.stack[k]?.trim(); if (v) clean[k] = v.slice(0, 400); }
  const row = (await c.q.query<{ id: string; settings: Record<string, string> }>('SELECT id, settings FROM company')).rows[0];
  if (!row) throw new DomainError('not_found', 'No company');
  const settings = { ...row.settings };
  for (const k of STACK_KEYS) delete settings[`stack_${k}`];
  for (const [k, v] of Object.entries(clean)) settings[`stack_${k}`] = v;
  if (clean.test_command) settings['test_command'] = clean.test_command;
  await c.q.query('UPDATE company SET settings = $2 WHERE id = $1', [row.id, JSON.stringify(settings)]);
  c.emit({ type: 'company.stack_set', aggregateType: 'company', aggregateId: row.id, payload: clean });
  return { stack: clean };
};

export function stackFrom(settings: Record<string, string>): Stack {
  const s: Stack = {};
  for (const k of STACK_KEYS) if (settings[`stack_${k}`]) s[k] = settings[`stack_${k}`];
  if (!s.test_command && settings['test_command']) s.test_command = settings['test_command'];
  return s;
}

// ---------------------------------------------------------------------------- connections

export const CONNECTION_KINDS = ['postgres', 'mysql'] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/**
 * An employee asks for a database. The request lands in the CEO's inbox as a form; when it comes from
 * a task, the task waits (awaiting input) until the CEO provides or declines it. An existing live
 * connection with the same name is returned instead of a duplicate request.
 */
export const requestConnection: Handler<{ kind: ConnectionKind; name: string; purpose: string; access?: 'read' | 'read_write'; taskId?: string },
  { connectionId: string; status: string; waiting: boolean }> = async (c, i) => {
  if (!CONNECTION_KINDS.includes(i.kind)) throw new DomainError('validation', `Supported databases: ${CONNECTION_KINDS.join(', ')}`);
  if (i.purpose.trim().length < 10) throw new DomainError('validation', 'Explain what the database is for (the CEO sees this)');
  if (c.principal.type !== 'employee') throw new DomainError('forbidden', 'Only employees request connections; the CEO adds them directly');
  const emp = await getEmployee(c.q, c.principal.id);
  let objectiveSponsor: string | null = null;
  if (i.taskId) {
    const task = await getTask(c.q, i.taskId);
    await c.authorize('connection.request', { type: 'Task', id: i.taskId }, await ownerContext(c, task));
    objectiveSponsor = (await getObjective(c.q, task.objective_id)).sponsor_user_id;
  } else {
    const run = c.principal.runId ? (await c.q.query<{ mode: string; status: string }>('SELECT mode, status FROM runs WHERE id = $1', [c.principal.runId])).rows[0] : undefined;
    await c.authorize('connection.request', { type: 'Department', id: emp.department_id }, { in_conversation: run?.mode === 'conversation' && run.status === 'running' });
  }
  const name = i.name.trim().slice(0, 60) || `${i.kind} database`;
  const live = (await c.q.query<{ id: string; status: string }>(
    `SELECT id, status FROM connections WHERE coalesce(department_id, '') = $1 AND kind = $2 AND lower(name) = lower($3) AND status IN ('requested','active')`,
    [emp.department_id, i.kind, name])).rows[0];
  if (live?.status === 'active') return { connectionId: live.id, status: 'active', waiting: false };
  const connectionId = live?.id ?? newId('con');
  if (!live) {
    await c.q.query(`INSERT INTO connections (id, kind, name, purpose, status, access, department_id, requested_by_employee_id, task_id)
                     VALUES ($1,$2,$3,$4,'requested',$5,$6,$7,$8)`,
      [connectionId, i.kind, name, i.purpose.trim().slice(0, 1000), i.access ?? 'read', emp.department_id, emp.id, i.taskId ?? null]);
    c.emit({ type: 'connection.requested', aggregateType: 'connection', aggregateId: connectionId,
      payload: { kind: i.kind, name, purpose: i.purpose.slice(0, 300), access: i.access ?? 'read', task_id: i.taskId ?? null, employee: emp.id } });
  }
  if (!i.taskId) return { connectionId, status: 'requested', waiting: false };
  // The task waits for the CEO: a blocking escalation tied to this connection.
  const escalationId = newId('esc');
  await c.q.query(`INSERT INTO escalations (id, task_id, raised_by_type, raised_by, type, body, dedup_key, routed_to_type, routed_to, status)
                   VALUES ($1,$2,'employee',$3,'blocker',$4,$5,'user',$6,'open') ON CONFLICT DO NOTHING`,
    [escalationId, i.taskId, emp.id, JSON.stringify({ question: `${emp.display_name} needs a ${i.kind} connection "${name}": ${i.purpose.trim()}`, connection_id: connectionId, blocking: true }),
      `connection:${connectionId}:${i.taskId}`, objectiveSponsor]);
  await transitionTask(c, i.taskId, 'RaiseBlocker', {}, { reason: `waiting for connection ${connectionId}`, runId: c.principal.runId });
  return { connectionId, status: 'requested', waiting: true };
};

async function resumeWaitingTasks(c: Parameters<Handler<unknown, unknown>>[0], connectionId: string, answer: string) {
  const open = (await c.q.query<{ id: string }>(`SELECT id FROM escalations WHERE status = 'open' AND body->>'connection_id' = $1`, [connectionId])).rows;
  for (const e of open) await resolveEscalation(c, { escalationId: e.id, answer });
}

/** The CEO provides the credentials (already in the vault) for a requested — or brand-new — connection. */
export const provideConnection: Handler<{ connectionId?: string; kind?: ConnectionKind; name?: string; purpose?: string; departmentKey?: string;
  config: { host: string; port: number; database: string; user: string; ssl?: boolean }; access: 'read' | 'read_write';
  secretId: string; keyFingerprint: string; check: { ok: true; version?: string; tables?: number } }, { connectionId: string; previousSecretId: string | null }> = async (c, i) => {
  await c.authorize('connection.provide', { type: 'Company', id: 'company' }, { action_class: 'A6' });
  if (!i.check?.ok) throw new DomainError('guard_failed', 'The connection must pass a live check before it is saved');
  let connectionId = i.connectionId;
  let previousSecretId: string | null = null;
  if (connectionId) {
    const row = (await c.q.query<{ status: string; secret_id: string | null }>('SELECT status, secret_id FROM connections WHERE id = $1 FOR UPDATE', [connectionId])).rows[0];
    if (!row) throw new DomainError('not_found', 'Connection not found');
    if (!['requested', 'active'].includes(row.status)) throw new DomainError('guard_failed', `Connection is ${row.status}`);
    previousSecretId = row.secret_id;
    await c.q.query(`UPDATE connections SET status = 'active', config = $2, access = $3, secret_id = $4, key_fingerprint = $5, last_check = $6, decided_by = $7,
                       updated_at = now(), version = version + 1 WHERE id = $1`,
      [connectionId, JSON.stringify(i.config), i.access, i.secretId, i.keyFingerprint, JSON.stringify({ ...i.check, at: c.now.toISOString() }), c.principal.id]);
  } else {
    if (!i.kind || !CONNECTION_KINDS.includes(i.kind) || !i.name?.trim()) throw new DomainError('validation', 'New connections need a kind and a name');
    const dep = i.departmentKey ? (await c.q.query<{ id: string }>('SELECT id FROM departments WHERE key = $1', [i.departmentKey])).rows[0] : undefined;
    if (i.departmentKey && !dep) throw new DomainError('not_found', `Team ${i.departmentKey} is not hired`);
    connectionId = newId('con');
    await c.q.query(`INSERT INTO connections (id, kind, name, purpose, status, access, department_id, config, secret_id, key_fingerprint, last_check, decided_by)
                     VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10,$11)`,
      [connectionId, i.kind, i.name.trim(), i.purpose?.trim() || 'Added by the CEO', i.access, dep?.id ?? null, JSON.stringify(i.config), i.secretId, i.keyFingerprint,
        JSON.stringify({ ...i.check, at: c.now.toISOString() }), c.principal.id]);
  }
  c.emit({ type: 'connection.provided', aggregateType: 'connection', aggregateId: connectionId,
    payload: { host: i.config.host, database: i.config.database, user: i.config.user, access: i.access, credential: i.keyFingerprint } });
  await resumeWaitingTasks(c, connectionId, `The CEO connected the database (connection ${connectionId}, ${i.access === 'read' ? 'read-only' : 'read/write'}). Use db.schema, db.query${i.access === 'read_write' ? ' and db.execute' : ''} with this connection_id.`);
  return { connectionId, previousSecretId };
};

export const declineConnection: Handler<{ connectionId: string; reason: string }, { ok: true }> = async (c, i) => {
  await c.authorize('connection.provide', { type: 'Company', id: 'company' }, { action_class: 'A6' });
  const r = await c.q.query(`UPDATE connections SET status = 'declined', decided_by = $2, updated_at = now(), version = version + 1 WHERE id = $1 AND status = 'requested' RETURNING id`, [i.connectionId, c.principal.id]);
  if (!r.rows.length) throw new DomainError('guard_failed', 'Only open requests can be declined');
  c.emit({ type: 'connection.declined', aggregateType: 'connection', aggregateId: i.connectionId, payload: { reason: i.reason } });
  await resumeWaitingTasks(c, i.connectionId, `The CEO declined this database request: ${i.reason || 'no reason given'}. Continue without it or propose an alternative.`);
  return { ok: true };
};

export const revokeConnection: Handler<{ connectionId: string }, { secretId: string | null }> = async (c, i) => {
  await c.authorize('connection.provide', { type: 'Company', id: 'company' }, { action_class: 'A6' });
  const row = (await c.q.query<{ secret_id: string | null }>(`UPDATE connections SET status = 'revoked', updated_at = now(), version = version + 1
    WHERE id = $1 AND status = 'active' RETURNING secret_id`, [i.connectionId])).rows[0];
  if (!row) throw new DomainError('guard_failed', 'Only active connections can be revoked');
  c.emit({ type: 'connection.revoked', aggregateType: 'connection', aggregateId: i.connectionId, payload: {} });
  return { secretId: row.secret_id };
};


// ---------------------------------------------------------------------------- instructions

export type InstructionScope = 'company' | 'department' | 'role' | 'employee';

/**
 * Set (or clear, with an empty body) the CEO's standing instructions for a scope. History is kept:
 * the previous version is superseded, never edited. Governance: CEO/admin with a fresh sign-in.
 */
export const setInstructions: Handler<{ scopeType: InstructionScope; departmentKey?: string; roleKey?: string; employeeId?: string; body: string }, { scopeId: string; version: number | null }> =
  async (c, i) => {
    await c.authorize('company.configure', { type: 'Company', id: 'company' }, { action_class: 'A6' });
    const body = i.body.trim();
    if (body.length > 4000) throw new DomainError('validation', 'Keep instructions under 4,000 characters');
    let scopeId: string;
    if (i.scopeType === 'company') scopeId = (await c.q.query<{ id: string }>('SELECT id FROM company')).rows[0]!.id;
    else if (i.scopeType === 'employee') {
      const e = (await c.q.query<{ id: string }>('SELECT id FROM employees WHERE id = $1', [i.employeeId ?? ''])).rows[0];
      if (!e) throw new DomainError('not_found', 'Employee not found');
      scopeId = e.id;
    } else {
      const d = (await c.q.query<{ id: string }>('SELECT id FROM departments WHERE key = $1', [i.departmentKey ?? ''])).rows[0];
      if (!d) throw new DomainError('not_found', `Team ${i.departmentKey} is not hired`);
      if (i.scopeType === 'role') {
        const r = (await c.q.query('SELECT 1 FROM employees WHERE department_id = $1 AND role_key = $2 LIMIT 1', [d.id, i.roleKey ?? ''])).rows[0];
        if (!r) throw new DomainError('not_found', `No ${i.roleKey} in ${i.departmentKey}`);
        scopeId = `${d.id}:${i.roleKey}`;
      } else scopeId = d.id;
    }
    const prev = (await c.q.query<{ version: number }>(`SELECT version FROM instructions WHERE scope_type = $1 AND scope_id = $2 ORDER BY version DESC LIMIT 1`, [i.scopeType, scopeId])).rows[0];
    await c.q.query(`UPDATE instructions SET status = $3 WHERE scope_type = $1 AND scope_id = $2 AND status = 'active'`, [i.scopeType, scopeId, body ? 'superseded' : 'removed']);
    const version = body ? (prev?.version ?? 0) + 1 : null;
    if (body) await c.q.query(`INSERT INTO instructions (id, scope_type, scope_id, body, version, status, set_by) VALUES ($1,$2,$3,$4,$5,'active',$6)`,
      [newId('ins'), i.scopeType, scopeId, body, version, c.principal.id]);
    c.emit({ type: body ? 'instructions.set' : 'instructions.cleared', aggregateType: 'instructions', aggregateId: `${i.scopeType}:${scopeId}`,
      payload: { scope_type: i.scopeType, scope_id: scopeId, version, preview: body.slice(0, 200) } });
    return { scopeId, version };
  };

/** The instructions that apply to one employee, broadest first (company → team → role → them). */
export async function instructionsFor(q: Parameters<Handler<unknown, unknown>>[0]['q'], employeeId: string): Promise<{ from: string; text: string }[]> {
  const e = (await q.query<{ department_id: string; role_key: string }>('SELECT department_id, role_key FROM employees WHERE id = $1', [employeeId])).rows[0];
  if (!e) return [];
  const rows = (await q.query<{ scope_type: InstructionScope; body: string }>(
    `SELECT scope_type, body FROM instructions WHERE status = 'active' AND (
       scope_type = 'company' OR (scope_type = 'department' AND scope_id = $1) OR (scope_type = 'role' AND scope_id = $2) OR (scope_type = 'employee' AND scope_id = $3))`,
    [e.department_id, `${e.department_id}:${e.role_key}`, employeeId])).rows;
  const order: InstructionScope[] = ['company', 'department', 'role', 'employee'];
  const label = { company: 'the whole company', department: 'your team', role: 'everyone in your role', employee: 'you personally' };
  return rows.sort((a, b) => order.indexOf(a.scope_type) - order.indexOf(b.scope_type)).map((r) => ({ from: label[r.scope_type], text: r.body }));
}
