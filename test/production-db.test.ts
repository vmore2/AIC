// The production database path: the ledger on a real PostgreSQL, hardened with docs/production-roles.sql, and
// the platform running as the restricted aic_engine role. History stays append-only even for the engine.
// Runs against a real PostgreSQL container (skipped when Docker is not running).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import { verifyChain } from '../src/ledger/engine.js';
import { Ledger } from '../src/ledger/ledger.js';
import { dept, modelsFor } from './helpers.js';

const IMAGE = 'postgres:16-alpine';
const dockerUp = (() => { try { execFileSync('docker', ['version'], { stdio: 'ignore', timeout: 15_000 }); return true; } catch { return false; } })();
let container = '';
let owner = '';
let engine = '';

async function sql(url: string, text: string) {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await c.query(text); } finally { await c.end(); }
}

beforeAll(async () => {
  if (!dockerUp) return;
  try { execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }); } catch { execFileSync('docker', ['pull', IMAGE], { stdio: 'ignore', timeout: 300_000 }); }
  container = execFileSync('docker', ['run', '-d', '--rm', '-e', 'POSTGRES_PASSWORD=owner-pw', '-e', 'POSTGRES_DB=aic', '-p', '127.0.0.1::5432', IMAGE], { encoding: 'utf8' }).trim();
  const port = Number(execFileSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim().split('\n')[0]!.split(':').pop());
  owner = `postgres://postgres:owner-pw@127.0.0.1:${port}/aic`;
  engine = `postgres://aic_engine:change-me@127.0.0.1:${port}/aic`;
  // Wait until Postgres accepts TCP logins (the image restarts once during init).
  for (let i = 0; i < 60; i++) {
    try { await sql(owner, 'SELECT 1'); break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
}, 400_000);
afterAll(() => { if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); });

describe.skipIf(!dockerUp)('production database: real PostgreSQL with the restricted engine role', () => {
  it('migrates as the owner, then works as aic_engine, which cannot rewrite history or the schema', async () => {
    // 1. First start as the owner applies the migrations.
    const first = await Ledger.open({ url: owner });
    const { ceoUserId } = await first.run('bootstrapCompany', { companyName: 'Prod Co', ceoName: 'Casey', defaultMode: 'M4' }, SYSTEM);
    await first.close();

    // 2. The owner applies the hardening script, twice: it must be safe to re-run after upgrades.
    const script = readFileSync('docs/production-roles.sql', 'utf8');
    await sql(owner, script);
    await sql(owner, script);

    // 3. The platform runs as aic_engine: it starts (no schema changes needed) and does real work.
    const ledger = await Ledger.open({ url: engine });
    try {
      const ceo: Principal = { type: 'user', id: ceoUserId, stepUp: true };
      const eng = dept('engineering');
      await ledger.run('hireDepartment', { template: eng, models: modelsFor(eng) }, ceo);
      const obj = await ledger.run('createObjective', { title: 'Slugs', departmentKey: 'engineering', budgetUsd: 50,
        requirements: [{ key: 'REQ-1', text: 'Provide slugify(text) in src/slugify.js.' }] }, ceo);
      expect(obj.objectiveId).toMatch(/^obj_/);
      expect((await verifyChain(ledger.db)).ok).toBe(true);
    } finally { await ledger.close(); }

    // 4. Even the engine cannot rewrite history, delete work, or change the schema.
    for (const attempt of ["UPDATE ledger_events SET payload = '{}' WHERE seq = 1", 'DELETE FROM ledger_events', 'DELETE FROM tasks',
      "UPDATE evidence SET result = 'pass'", 'CREATE TABLE sneaky (a int)', 'DROP TABLE tasks'])
      await expect(sql(engine, attempt), attempt).rejects.toThrow(/permission denied|must be owner/);
  }, 120_000);
});
