// Team catalog + team builder API. Custom teams are saved as short team specs in the company's
// own `teams/` folder (version them in git); recommended teams ship with the platform.
import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import type { App } from '../app.js';
import type { Principal } from '../domain/types.js';
import { DomainError } from '../ledger/engine.js';
import { entryFrom, loadCatalog, saveTeamSpec, type CatalogEntry } from '../org/catalog.js';
import { CAPABILITIES, TeamSpecSchema } from '../org/teamSpec.js';
import { profileForRole } from '../runtime/models.js';

export function summarize(e: CatalogEntry, hired: Set<string>) {
  const d = e.department;
  return {
    key: e.key, name: d?.name ?? e.name, source: e.source, format: e.format, hired: hired.has(e.key),
    purpose: d?.purpose ?? '', mode: d?.default_mode, risk: d?.risk_floor, errors: e.errors, warnings: e.warnings, notes: e.notes,
    neverAutonomous: d?.never_autonomous ?? [],
    roles: (d?.roles ?? []).map((r) => ({
      key: r.key, title: r.title, category: r.category, does: r.charter, profile: r.rule_of_two_profile,
      count: d!.structure.find((s) => s.role === r.key)?.count ?? 0, reportsTo: d!.structure.find((s) => s.role === r.key)?.reports_to ?? '',
      tools: r.tools, reviewer: r.reviewer_role ?? null, criteria: r.criteria_templates.map((c) => ({ statement: c.statement, kind: c.kind, by: c.independence })),
    })),
    workflow: d?.workflows[0]?.stages.map((s) => ({ key: s.key, gate: s.gate })) ?? [],
  };
}

export function registerTeamRoutes(server: FastifyInstance, app: App, who: (req: FastifyRequest) => Promise<Principal>) {
  const db = app.ledger.db;
  const hiredKeys = async () => new Set((await db.query<{ key: string }>('SELECT key FROM departments')).rows.map((r) => r.key));
  const catalog = () => loadCatalog(app.config.teams_path);

  server.get('/api/capabilities', async () => Object.entries(CAPABILITIES).map(([key, v]) => ({ key, label: v.label })));
  server.get('/api/catalog', async () => { const h = await hiredKeys(); return catalog().entries.map((e) => summarize(e, h)); });
  server.get<{ Params: { key: string } }>('/api/catalog/:key/spec', async (req) => {
    const e = catalog().get(req.params.key);
    if (!e) throw new DomainError('not_found', 'Unknown team');
    if (e.format !== 'team_spec') throw new DomainError('validation', 'Only short team specs can be edited in the builder; edit the full template file directly');
    return parseYaml(readFileSync(e.file, 'utf8'));
  });
  server.post<{ Body: { spec: unknown } }>('/api/teams/check', async (req) => summarize(entryFrom(req.body.spec, 'custom', 'draft.yaml'), await hiredKeys()));
  server.post<{ Body: { spec: unknown } }>('/api/teams', async (req) => {
    // Saving a team definition is governance: only the owner session or admins may do it.
    const p = await who(req);
    const role = (await db.query<{ role: string }>('SELECT role FROM users WHERE id = $1', [p.id])).rows[0]?.role;
    if (!(p.stepUp && (role === 'ceo' || role === 'admin'))) throw new DomainError('forbidden', 'Only the CEO or an admin (owner session) can save team definitions');
    const parsed = TeamSpecSchema.safeParse(req.body.spec);
    if (!parsed.success) throw new DomainError('validation', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const draft = entryFrom(req.body.spec, 'custom', `${parsed.data.team}.yaml`);
    // Cross-team rules (role keys unique across the company) are checked against the whole catalog.
    const others = catalog().entries.filter((e) => e.key !== parsed.data.team);
    const clash = draft.department?.roles.find((r) => others.some((o) => o.department?.roles.some((x) => x.key === r.key)));
    if (clash) draft.errors.push(`Role "${clash.title}" (${clash.key}) already exists in another team; rename it or give it a "key"`);
    if (draft.errors.length) throw new DomainError('validation', 'Team has errors', { errors: draft.errors });
    const file = saveTeamSpec(app.config.teams_path, parsed.data.team, `# Created with the dashboard team builder.\n${toYaml(req.body.spec)}`);
    return { saved: file, team: summarize(draft, await hiredKeys()) };
  });
  server.post<{ Params: { key: string } }>('/api/catalog/:key/hire', async (req) => {
    const e = catalog().get(req.params.key);
    if (!e?.department) throw new DomainError('not_found', 'Unknown team');
    if (e.errors.length) throw new DomainError('validation', 'Team has errors', { errors: e.errors });
    const models = Object.fromEntries(e.department.roles.map((r) => [r.key, profileForRole(app.config, r.key)]));
    return app.ledger.run('hireDepartment', { template: e.department, models }, await who(req));
  });
}
