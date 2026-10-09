// `aic doctor`: readiness checks against the customer's own infrastructure.
import type { App } from '../app.js';
import { verifyChain } from '../ledger/engine.js';
import { loadCatalog } from '../org/catalog.js';
import { profileForRole } from '../runtime/models.js';

export interface Check { check: string; level: 'pass' | 'warn' | 'fail'; detail: string; fix?: string }

export async function runDoctor(app: App): Promise<Check[]> {
  const out: Check[] = [];
  const add = (check: string, level: Check['level'], detail: string, fix?: string) => out.push({ check, level, detail, ...(fix ? { fix } : {}) });
  const cfg = app.config;
  const db = app.ledger.db;

  // Database
  try {
    await db.query('SELECT 1');
    const local = 'local_path' in cfg.database ? cfg.database.local_path : null;
    add('Database', local ? 'warn' : 'pass', local ? `embedded PostgreSQL at ${local}` : 'connected to your PostgreSQL',
      local ? 'For production set database: { url_env: DATABASE_URL } and apply docs/production-roles.sql' : undefined);
  } catch (e) { add('Database', 'fail', (e as Error).message, 'Check DATABASE_URL and network access'); return out; }
  const company = (await db.query<{ name: string }>('SELECT name FROM company')).rows[0];
  add('Company', company ? 'pass' : 'fail', company ? company.name : 'not initialized', company ? undefined : 'Run aic init');

  const chain = await verifyChain(db);
  add('Ledger integrity', chain.ok ? 'pass' : 'fail', chain.ok ? `hash chain intact (${chain.checked} events)` : `chain breaks at event ${chain.brokenAt}`, chain.ok ? undefined : 'Treat as a security incident; see docs');

  // Models
  const real = cfg.models.profiles.filter((p) => p.provider !== 'scripted');
  if (!real.length) add('Model providers', 'warn', 'only the offline scripted model is configured (demo scenarios only)', 'Add an OpenAI-compatible or Anthropic profile in aic.config.yaml');
  for (const p of real) {
    const has = !!(p.api_key_env && process.env[p.api_key_env]);
    add(`Model: ${p.key}`, has ? 'pass' : 'fail', `${p.provider} ${p.model} (family ${p.family})`, has ? undefined : `Set ${p.api_key_env ?? 'api_key_env'} in the environment`);
    if (p.price_per_million.input === 0 && p.price_per_million.output === 0) add(`Prices: ${p.key}`, 'warn', 'no prices configured; budgets will not limit spend', 'Set price_per_million to your contract prices');
  }

  // Teams
  const catalog = loadCatalog(cfg.teams_path);
  const broken = catalog.entries.filter((e) => e.errors.length);
  add('Team catalog', broken.length ? 'fail' : 'pass', `${catalog.entries.length} teams (${catalog.entries.filter((e) => e.source === 'custom').length} custom)${broken.length ? `; errors in ${broken.map((b) => b.key).join(', ')}` : ''}`,
    broken.length ? 'Run aic teams check' : undefined);
  const hired = (await db.query<{ key: string; template: { roles: { key: string; category: string }[] } }>('SELECT key, template FROM departments')).rows;
  add('Hired teams', hired.length ? 'pass' : 'warn', hired.length ? hired.map((h) => h.key).join(', ') : 'none', hired.length ? undefined : 'aic hire <team>');
  for (const h of hired) {
    const producers = new Set(h.template.roles.filter((r) => r.category !== 'reviewer').map((r) => profileForRole(cfg, r.key).family));
    const sameFamily = h.template.roles.filter((r) => r.category === 'reviewer' && producers.has(profileForRole(cfg, r.key).family));
    if (sameFamily.length) add(`Reviewer independence: ${h.key}`, 'warn', `${sameFamily.map((r) => r.key).join(', ')} use the same model family as producers; R2+ reviews will not count`,
      'Assign reviewer roles to a profile from a different model family (models.assignments)');
  }

  // Code hosting
  try {
    const sha = await app.workspaces.remoteSha(`refs/heads/${app.workspaces.host.baseBranch}`);
    add('Code hosting', sha ? 'pass' : 'fail', `${app.workspaces.host.description}${sha ? ` (${app.workspaces.host.baseBranch} @ ${sha.slice(0, 8)})` : ': base branch not found'}`);
  } catch (e) { add('Code hosting', 'fail', (e as Error).message.slice(0, 200), 'Check code_hosting settings and token'); }

  // Sandbox
  const sb = app.sandbox;
  if (sb.isolated) {
    const probe = await sb.exec(process.cwd(), 'echo ok', 60_000).catch((e) => ({ exitCode: null, stdout: '', stderr: String(e), timedOut: false }));
    add('Sandbox', probe.exitCode === 0 ? 'pass' : 'fail', probe.exitCode === 0 ? `${sb.description}` : `${sb.description}: ${probe.stderr.slice(0, 160)}`,
      probe.exitCode === 0 ? undefined : 'Start Docker and pull the sandbox image');
  } else add('Sandbox', cfg.sandbox.allow_unisolated_local ? 'warn' : 'fail', sb.description,
    'Production: sandbox: { kind: docker } (Docker installed) or your own microVM/gVisor sandbox');

  // Secrets and access
  add('Run credential secret', process.env[cfg.credential_secret_env] ? 'pass' : 'warn', process.env[cfg.credential_secret_env] ? 'from environment' : 'generated file in storage',
    process.env[cfg.credential_secret_env] ? undefined : `Set ${cfg.credential_secret_env} from your secret manager`);
  add('Dashboard access', process.env['AIC_DASHBOARD_TOKEN'] ? 'pass' : 'warn', 'localhost only, token-protected', 'For team access put the dashboard behind your SSO + MFA and set AIC_DASHBOARD_TOKEN');
  return out;
}
