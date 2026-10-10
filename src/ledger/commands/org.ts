// Organization commands: company bootstrap, hiring departments, operating modes.
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../../domain/hash.js';
import { newId } from '../../domain/ids.js';
import { MODES, type Mode } from '../../domain/types.js';
import type { ModelProfile } from '../../config/config.js';
import { DepartmentSchema, type Department, type Role } from '../../org/schema.js';
import { validateDepartment } from '../../org/validate.js';
import { DomainError, type Handler } from '../engine.js';

export const bootstrapCompany: Handler<{ companyName: string; ceoName: string; ceoEmail?: string; defaultMode: Mode; projectSettings?: Record<string, string> }, { companyId: string; ceoUserId: string }> =
  async (c, i) => {
    await c.authorize('company.bootstrap', { type: 'Company', id: 'company' }, {});
    const existing = await c.q.query('SELECT id FROM company');
    if (existing.rows.length) throw new DomainError('conflict', 'Company already initialized');
    const companyId = newId('co');
    const ceoUserId = newId('usr');
    await c.q.query('INSERT INTO company (id, name, settings) VALUES ($1,$2,$3)', [companyId, i.companyName, JSON.stringify(i.projectSettings ?? {})]);
    await c.q.query(`INSERT INTO users (id, name, email, role) VALUES ($1,$2,$3,'ceo')`, [ceoUserId, i.ceoName, i.ceoEmail ?? null]);
    await c.q.query(`INSERT INTO mode_settings (scope_type, scope_id, mode, set_by, reason) VALUES ('company', $1, $2, 'system', 'initial default')`, [companyId, i.defaultMode]);
    c.emit({ type: 'company.created', aggregateType: 'company', aggregateId: companyId, payload: { name: i.companyName, ceo_user_id: ceoUserId, mode: i.defaultMode } });
    return { companyId, ceoUserId };
  };

export const addUser: Handler<{ name: string; email?: string; role: 'admin' | 'approver' | 'member' | 'viewer' | 'auditor' }, { userId: string }> = async (c, i) => {
  await c.authorize('employee.hire', { type: 'Company', id: 'company' }, {});
  const userId = newId('usr');
  const email = i.email?.trim().toLowerCase() || null;
  if (email && (await c.q.query('SELECT 1 FROM users WHERE lower(email) = $1', [email])).rows.length) throw new DomainError('conflict', `${email} already belongs to another user`);
  await c.q.query('INSERT INTO users (id, name, email, role) VALUES ($1,$2,$3,$4)', [userId, i.name, email, i.role]);
  c.emit({ type: 'user.added', aggregateType: 'user', aggregateId: userId, payload: { name: i.name, role: i.role } });
  return { userId };
};

/** Set the email a person signs in with (Google sign-in maps verified emails to users). */
export const setUserEmail: Handler<{ userId: string; email: string }, { userId: string }> = async (c, i) => {
  await c.authorize('employee.hire', { type: 'Company', id: 'company' }, {});
  const email = i.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new DomainError('validation', `"${i.email}" is not an email address`);
  const u = (await c.q.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [i.userId])).rows[0];
  if (!u) throw new DomainError('not_found', `User ${i.userId} not found`);
  const taken = (await c.q.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1 AND id <> $2', [email, i.userId])).rows[0];
  if (taken) throw new DomainError('conflict', `${email} already belongs to another user`);
  await c.q.query('UPDATE users SET email = $2 WHERE id = $1', [i.userId, email]);
  c.emit({ type: 'user.email_set', aggregateType: 'user', aggregateId: i.userId, payload: { email } });
  return { userId: i.userId };
};

/** Check a model profile can serve a role (architecture.md §9.7). */
export function capabilityGaps(role: Role, p: ModelProfile): string[] {
  const gaps: string[] = [];
  if (role.capabilities_required.structured_output && !p.structured_output) gaps.push('structured_output');
  if (role.capabilities_required.tool_calling && !p.tool_calling) gaps.push('tool_calling');
  if (p.context_tokens < role.capabilities_required.min_context_tokens) gaps.push(`context_tokens>=${role.capabilities_required.min_context_tokens}`);
  return gaps;
}

export interface HireInput {
  template: Department;
  /** role key → model profile used by that role's employees (customer-supplied). */
  models: Record<string, ModelProfile>;
}

export const hireDepartment: Handler<HireInput, { departmentId: string; employees: { id: string; role: string; name: string }[] }> = async (c, i) => {
  await c.authorize('employee.hire', { type: 'Company', id: 'company' }, {});
  const dept = DepartmentSchema.parse(i.template);
  const errors = validateDepartment(dept).filter((f) => f.level === 'error');
  if (errors.length) throw new DomainError('validation', `Department template "${dept.key}" violates the architecture rules`, { findings: errors });
  if ((await c.q.query('SELECT 1 FROM departments WHERE key = $1', [dept.key])).rows.length)
    throw new DomainError('conflict', `Department "${dept.key}" is already hired`);

  const ceo = (await c.q.query<{ id: string }>(`SELECT id FROM users WHERE role = 'ceo' LIMIT 1`)).rows[0];
  if (!ceo) throw new DomainError('not_found', 'No CEO user');
  const roles = new Map(dept.roles.map((r) => [r.key, r]));
  for (const r of dept.roles) {
    const p = i.models[r.key];
    if (!p) throw new DomainError('validation', `No model profile assigned for role ${r.key}`);
    const gaps = capabilityGaps(r, p);
    if (gaps.length) throw new DomainError('validation', `Model profile "${p.key}" cannot serve role ${r.key}: missing ${gaps.join(', ')}`);
  }

  const departmentId = newId('dep');
  await c.q.query('INSERT INTO departments (id, key, name, template_version, template, default_mode, risk_floor) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [departmentId, dept.key, dept.name, dept.version, JSON.stringify(dept), dept.default_mode, dept.risk_floor]);
  await c.q.query(`INSERT INTO mode_settings (scope_type, scope_id, mode, set_by, reason) VALUES ('department', $1, $2, $3, 'template default')`,
    [departmentId, dept.default_mode, c.principal.id]);

  // Seats are created top-down so managers exist before their reports.
  const firstOfRole = new Map<string, string>();
  const created: { id: string; role: string; name: string }[] = [];
  const pending = [...dept.structure];
  let guard = 0;
  while (pending.length && guard++ < 50) {
    const idx = pending.findIndex((s) => s.reports_to === 'ceo' || firstOfRole.has(s.reports_to));
    if (idx < 0) throw new DomainError('validation', 'Structure has unreachable seats');
    const seat = pending.splice(idx, 1)[0]!;
    const role = roles.get(seat.role)!;
    const profile = i.models[seat.role]!;
    for (let n = 1; n <= seat.count; n++) {
      const id = newId('emp');
      const name = seat.count > 1 ? `${role.title} ${n}` : role.title;
      await c.q.query(
        `INSERT INTO employees (id, display_name, department_id, role_key, role_version, role_snapshot, category, can_manage,
           manager_employee_id, reports_to_user_id, model_profile, model_family, tool_grants)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, name, departmentId, role.key, role.version, JSON.stringify(role), role.category, role.can_manage,
          seat.reports_to === 'ceo' ? null : firstOfRole.get(seat.reports_to), seat.reports_to === 'ceo' ? ceo.id : null,
          profile.key, profile.family, JSON.stringify(role.tools.filter((t) => !role.denied_tools.includes(t)))]);
      if (!firstOfRole.has(role.key)) firstOfRole.set(role.key, id);
      created.push({ id, role: role.key, name });
      c.emit({ type: 'employee.hired', aggregateType: 'employee', aggregateId: id,
        payload: { department: dept.key, role: role.key, role_version: role.version, model_profile: profile.key, model_family: profile.family, reports_to: seat.reports_to } });
    }
  }
  c.emit({ type: 'department.hired', aggregateType: 'department', aggregateId: departmentId, payload: { key: dept.key, version: dept.version, employees: created.length } });
  return { departmentId, employees: created };
};

export const setMode: Handler<{ scopeType: 'company' | 'department' | 'objective'; scopeId: string; mode: Mode; reason: string }, { mode: Mode }> = async (c, i) => {
  if (!MODES.includes(i.mode)) throw new DomainError('validation', `Unknown mode ${i.mode}`);
  if (i.reason.trim().length < 3) throw new DomainError('validation', 'A reason is required to change modes');
  await c.authorize('mode.set', { type: 'Scope', id: `${i.scopeType}:${i.scopeId}` }, { action_class: 'A6' });
  const prev = (await c.q.query<{ mode: string }>('SELECT mode FROM mode_settings WHERE scope_type=$1 AND scope_id=$2', [i.scopeType, i.scopeId])).rows[0];
  await c.q.query(
    `INSERT INTO mode_settings (scope_type, scope_id, mode, set_by, reason) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (scope_type, scope_id) DO UPDATE SET mode=$3, set_by=$4, reason=$5, set_at=now(), version=mode_settings.version+1`,
    [i.scopeType, i.scopeId, i.mode, c.principal.id, i.reason]);
  c.emit({ type: 'mode.changed', aggregateType: 'scope', aggregateId: `${i.scopeType}:${i.scopeId}`, payload: { from: prev?.mode ?? null, to: i.mode, reason: i.reason } });
  return { mode: i.mode };
};

/** Issue a personal access token for a teammate. The plaintext is returned once; only its hash is stored. */
export const issueAccessToken: Handler<{ userId: string; label: string }, { tokenId: string; token: string }> = async (c, i) => {
  await c.authorize('employee.hire', { type: 'User', id: i.userId }, { action_class: 'A6' });
  const u = (await c.q.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [i.userId])).rows[0];
  if (!u) throw new DomainError('not_found', 'User not found');
  const tokenId = newId('pat');
  const token = `aic_${randomBytes(24).toString('base64url')}`;
  await c.q.query('INSERT INTO access_tokens (id, user_id, label, token_sha256, created_by) VALUES ($1,$2,$3,$4,$5)', [tokenId, i.userId, i.label, sha256Hex(token), c.principal.id]);
  c.emit({ type: 'access_token.issued', aggregateType: 'user', aggregateId: i.userId, payload: { token_id: tokenId, label: i.label, role: u.role } });
  return { tokenId, token };
};

export const revokeAccessToken: Handler<{ tokenId: string }, { revoked: boolean }> = async (c, i) => {
  await c.authorize('employee.hire', { type: 'AccessToken', id: i.tokenId }, { action_class: 'A6' });
  const r = await c.q.query<{ user_id: string }>('UPDATE access_tokens SET revoked_at = now() WHERE (id = $1 OR user_id = $1) AND revoked_at IS NULL RETURNING user_id', [i.tokenId]);
  for (const row of r.rows) c.emit({ type: 'access_token.revoked', aggregateType: 'user', aggregateId: row.user_id, payload: { token_id: i.tokenId } });
  return { revoked: r.rows.length > 0 };
};
