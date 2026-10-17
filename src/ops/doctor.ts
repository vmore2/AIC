// `aic doctor`: readiness checks against the customer's own infrastructure.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { App } from '../app.js';
import { verifyChain } from '../ledger/engine.js';
import { loadCatalog } from '../org/catalog.js';

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

  // Models: the ones in aic.config.yaml and the ones the CEO added in the dashboard (keys in the vault).
  const real = app.models.profiles.filter((p) => p.provider !== 'scripted');
  if (!real.length) add('Model providers', 'warn', 'only the offline scripted model is configured (demo scenarios only)', 'Dashboard → Setup → AI models, or add a profile in aic.config.yaml');
  for (const p of real) {
    const key = p.api_key_secret ? { ok: app.vault.has(p.api_key_secret), where: 'key in your vault', fix: 'Re-add the provider in Setup → AI models' }
      : p.api_key_env ? { ok: !!process.env[p.api_key_env], where: `key from ${p.api_key_env}`, fix: `Set ${p.api_key_env} in .env` }
      : { ok: true, where: 'no key (local endpoint)', fix: '' };
    add(`Model: ${p.key}`, key.ok ? 'pass' : 'fail', `${p.provider} ${p.model} (family ${p.family}; ${key.where})`, key.ok ? undefined : key.fix);
    if (p.price_per_million.input === 0 && p.price_per_million.output === 0 && (p.api_key_env || p.api_key_secret))
      add(`Prices: ${p.key}`, 'warn', 'no prices configured; budgets will not limit spend', 'Set price_per_million to your contract prices');
  }

  // Teams
  const catalog = loadCatalog(cfg.teams_path);
  const broken = catalog.entries.filter((e) => e.errors.length);
  add('Team catalog', broken.length ? 'fail' : 'pass', `${catalog.entries.length} teams (${catalog.entries.filter((e) => e.source === 'custom').length} custom)${broken.length ? `; errors in ${broken.map((b) => b.key).join(', ')}` : ''}`,
    broken.length ? 'Run aic teams check' : undefined);
  const hired = (await db.query<{ key: string }>('SELECT key FROM departments')).rows;
  add('Hired teams', hired.length ? 'pass' : 'warn', hired.length ? hired.map((h) => h.key).join(', ') : 'none', hired.length ? undefined : 'aic hire <team>');
  // Reviewer independence, from the models the hired employees actually use.
  const staff = (await db.query<{ team: string; role_key: string; category: string; model_profile: string }>(
    `SELECT d.key AS team, e.role_key, e.category, e.model_profile FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.status = 'active'`)).rows;
  const familyOf = (key: string) => app.models.profiles.find((p) => p.key === key)?.family ?? key;
  for (const h of hired) {
    const team = staff.filter((s) => s.team === h.key);
    const producers = new Set(team.filter((s) => s.category !== 'reviewer').map((s) => familyOf(s.model_profile)));
    const sameFamily = [...new Set(team.filter((s) => s.category === 'reviewer' && producers.has(familyOf(s.model_profile))).map((s) => s.role_key))];
    if (sameFamily.length) add(`Reviewer independence: ${h.key}`, 'warn', `${sameFamily.join(', ')} use the same model family as producers; R2+ reviews will not count`,
      'Give reviewer roles a model from a different family (Setup → Who uses which model, or models.assignments)');
  }

  // Code hosting
  try {
    const sha = await app.workspaces.remoteSha(`refs/heads/${app.workspaces.host.baseBranch}`);
    add('Code hosting', sha ? 'pass' : 'fail', `${app.workspaces.host.description}${sha ? ` (${app.workspaces.host.baseBranch} @ ${sha.slice(0, 8)})` : ': base branch not found'}`);
  } catch (e) { add('Code hosting', 'fail', (e as Error).message.slice(0, 200), 'Check code_hosting settings and token'); }

  // Sandbox
  const sb = app.sandbox;
  if (sb.isolated) {
    // Probe like a real run: a workspace the platform created, which the sandboxed command must read and write.
    mkdirSync(app.workspaces.root, { recursive: true });
    const ws = mkdtempSync(path.join(app.workspaces.root, 'doctor-'));
    try {
      writeFileSync(path.join(ws, 'probe.txt'), 'probe');
      const probe = await sb.exec(ws, 'cat probe.txt && echo ok > written.txt', 60_000).catch((e) => ({ exitCode: null, stdout: '', stderr: String(e), timedOut: false }));
      const ran = probe.exitCode !== null && !/Unable to find image|Cannot connect|error during connect|not found/i.test(probe.stderr);
      const ok = probe.exitCode === 0 && probe.stdout.includes('probe') && existsSync(path.join(ws, 'written.txt'));
      add('Sandbox', ok ? 'pass' : 'fail', ok ? `${sb.description}` : `${sb.description}: ${(probe.stderr || 'the sandboxed command could not read and write its workspace').slice(0, 160)}`,
        ok ? undefined : ran ? 'Commands in the container cannot use the workspace: run the platform as a regular (non-root) user, or set sandbox.docker.user to the uid:gid that owns the storage folder'
          : 'Start Docker and pull the sandbox image');
    } finally { rmSync(ws, { recursive: true, force: true }); }
  } else add('Sandbox', cfg.sandbox.allow_unisolated_local ? 'warn' : 'fail', sb.description,
    'Production: sandbox: { kind: docker } (Docker installed) or your own microVM/gVisor sandbox');

  // Windows path depth: git cannot reliably read clones deeper than ~245 characters, and workspaces add ~50.
  if (process.platform === 'win32') {
    const depth = app.workspaces.root.length;
    if (depth > 180) add('Storage path length', 'warn', `${depth} characters deep (${app.workspaces.root}); git on Windows fails on very long paths`,
      'Move the company folder closer to the drive root, or set storage_path: C:/aic/storage in aic.config.yaml');
  }

  // Secrets and access
  add('Run credential secret', process.env[cfg.credential_secret_env] ? 'pass' : 'warn', process.env[cfg.credential_secret_env] ? 'from environment' : 'generated file in storage',
    process.env[cfg.credential_secret_env] ? undefined : `Set ${cfg.credential_secret_env} from your secret manager`);
  add('Dashboard access', process.env['AIC_DASHBOARD_TOKEN'] ? 'pass' : 'warn', 'localhost only, token-protected', 'For team access put the dashboard behind your SSO + MFA and set AIC_DASHBOARD_TOKEN');
  return out;
}
