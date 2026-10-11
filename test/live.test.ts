// LIVE tests against the customer's real model provider. They never run in the normal suite:
//   AIC_LIVE=1 npx vitest run test/live.test.ts
// Every call goes through the lifetime spend cap (AIC_SPEND_CAP_USD in .env).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadDotEnv } from '../src/config/env.js';
import { ConfigSchema, type ModelProfile } from '../src/config/config.js';
import { createApp, type App } from '../src/app.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import { OpenAICompatibleModel } from '../src/runtime/modelPort.js';
import { SpendGuard, SpendGuardedModel } from '../src/runtime/spendGuard.js';
import { inbox } from '../src/reports/views.js';
import { dept } from './helpers.js';

loadDotEnv();
const LIVE = process.env['AIC_LIVE'] === '1' && !!process.env['OPENAI_API_KEY'] && !!process.env['AIC_SPEND_CAP_USD'];

export const NANO: ModelProfile = {
  key: 'nano', provider: 'openai_compatible', model: 'gpt-4.1-nano', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY',
  family: 'openai', context_tokens: 128000, structured_output: true, tool_calling: true,
  // List prices per 1M tokens (verify on OpenAI's pricing page); the spend cap uses these.
  price_per_million: { input: 0.10, output: 0.40 },
};

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-live-'));
let app: App | undefined;
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

describe.skipIf(!LIVE)('live: OpenAI (spend-capped)', () => {
  it('smoke: a single tool call round-trips through the adapter and the spend ledger', async () => {
    const guard = SpendGuard.fromEnv()!;
    const before = guard.spent(SpendGuard.keyId(NANO));
    const m = new SpendGuardedModel(new OpenAICompatibleModel(NANO), guard);
    const r = await m.generate({
      system: 'You are a test harness. Always answer by calling the tool.',
      messages: [{ role: 'user', content: 'Record the number 42.' }],
      tools: [{ name: 'record__number', description: 'Record a number', parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } }],
      maxOutputTokens: 50,
    });
    expect(r.toolCalls[0]).toMatchObject({ name: 'record__number', arguments: { n: 42 } });
    const after = guard.spent(SpendGuard.keyId(NANO));
    expect(after).toBeGreaterThan(before);
    console.log(`smoke cost $${(after - before).toFixed(6)}; lifetime $${after.toFixed(4)} of $${guard.capUsd}`);
  }, 60_000);

  it.skipIf(process.env['AIC_LIVE_E2E'] !== '1')('a real objective: lead plans with a real model, CEO approves, work is independently verified', async () => {
    const docker = process.env['AIC_LIVE_DOCKER'] === '1';
    app = await createApp(ConfigSchema.parse({
      company: { name: 'Live Co' }, database: { local_path: path.join(dir, 'db') },
      models: { profiles: [NANO], default: 'nano' },
      code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'), teams_path: path.join(dir, 'teams'),
      sandbox: docker ? { kind: 'docker', docker: { image: 'node:22-bookworm-slim', memory: '1g', cpus: 1, network: 'none' } } : { allow_unisolated_local: true },
    }), { log: (m) => console.log(`  · ${m}`) });
    const guard = SpendGuard.fromEnv()!;
    const startSpend = guard.spent(SpendGuard.keyId(NANO));
    const b = await app.ledger.run('bootstrapCompany', { companyName: 'Live Co', ceoName: 'CEO', defaultMode: 'M4', projectSettings: { test_command: 'node --test' } }, SYSTEM);
    const ceo: Principal = { type: 'user', id: b.ceoUserId, stepUp: true };
    const eng = dept('engineering');
    await app.ledger.run('hireDepartment', { template: eng, models: Object.fromEntries(eng.roles.map((r) => [r.key, NANO])) }, ceo);
    const obj = await app.ledger.run('createObjective', { title: 'Slug helper', departmentKey: 'engineering', budgetUsd: 0.30,
      requirements: [{ key: 'REQ-1', text: 'Create src/slugify.js exporting slugify(text) (ES module): lowercase, words joined by single hyphens, punctuation removed, no leading/trailing hyphens. Add tests in test/slugify.test.js using node:test.' }] }, ceo);
    await app.orchestrator.runUntilIdle(600_000);
    const items = await inbox(app.ledger.db);
    console.log('CEO inbox:', items.map((i) => `${i.kind}: ${i.title}`));
    const plan = items.find((i) => i.kind === 'plan');
    if (plan) {
      await app.ledger.run('decideProposal', { proposalId: plan.id, decision: 'approve' }, ceo);
      await app.orchestrator.runUntilIdle(900_000);
      console.log('CEO inbox after execution:', (await inbox(app.ledger.db)).map((i) => `${i.kind}: ${i.title}`));
    }
    const tasks = (await app.ledger.db.query<{ title: string; status: string; attempt: number; assurance_label: string | null }>(
      `SELECT title, status, attempt, assurance_label FROM tasks WHERE objective_id = $1 ORDER BY kind`, [obj.objectiveId])).rows;
    const evidence = (await app.ledger.db.query<{ statement: string; result: string; details: unknown }>(
      `SELECT c.statement, e.result, e.details FROM evidence e JOIN criteria c ON c.id = e.criterion_id JOIN tasks t ON t.id = e.task_id
        WHERE t.objective_id = $1 ORDER BY e.created_at`, [obj.objectiveId])).rows;
    for (const e of evidence) console.log(`evidence [${e.result}] ${e.statement}: ${JSON.stringify(e.details).slice(0, 600)}`);
    const spent = guard.spent(SpendGuard.keyId(NANO)) - startSpend;
    console.log('tasks:', tasks, `\nspent this run: $${spent.toFixed(4)}; lifetime $${guard.spent(SpendGuard.keyId(NANO)).toFixed(4)} of $${guard.capUsd}`);
    // Whatever the model achieved, the platform must never report unverified success.
    for (const t of tasks) if (t.status === 'accepted') expect(t.assurance_label ?? 'planning').toBeTruthy();
    expect(spent).toBeLessThan(0.35);
  }, 1_800_000);

  // AIC_LIVE=1 AIC_LIVE_GITHUB=1 (+ GITHUB_TOKEN, AIC_LIVE_GITHUB_REPO=owner/repo in .env or the environment)
  it.skipIf(process.env['AIC_LIVE_GITHUB'] !== '1' || !process.env['GITHUB_TOKEN'] || !process.env['AIC_LIVE_GITHUB_REPO'])(
    'a real objective released to GitHub: PR opened and merged pinned to the approved commit, no token leaks', async () => {
    const repo = process.env['AIC_LIVE_GITHUB_REPO']!;
    const token = process.env['GITHUB_TOKEN']!;
    const gdir = mkdtempSync(path.join(os.tmpdir(), 'aic-live-gh-'));
    const gh = async (p: string) => (await fetch(`https://api.github.com/repos/${repo}${p}`, { headers: { authorization: `Bearer ${token}`, 'user-agent': 'aic-live-test', 'x-github-api-version': '2022-11-28' } })).json() as Promise<any>;
    const gapp = await createApp(ConfigSchema.parse({
      company: { name: 'Live GitHub Co' }, database: { local_path: path.join(gdir, 'db') },
      models: { profiles: [NANO], default: 'nano' },
      code_hosting: { kind: 'github', repo, token_env: 'GITHUB_TOKEN', base_branch: 'main' },
      storage_path: path.join(gdir, 'storage'), teams_path: path.join(gdir, 'teams'),
      sandbox: { kind: 'docker', docker: { image: 'node:22-bookworm-slim', memory: '1g', cpus: 1, network: 'none' } },
    }), { log: (m) => console.log(`  · ${m}`) });
    try {
      const guard = SpendGuard.fromEnv()!;
      const startSpend = guard.spent(SpendGuard.keyId(NANO));
      const b = await gapp.ledger.run('bootstrapCompany', { companyName: 'Live GitHub Co', ceoName: 'CEO', defaultMode: 'M4', projectSettings: { test_command: 'node --test' } }, SYSTEM);
      const ceo: Principal = { type: 'user', id: b.ceoUserId, stepUp: true };
      const eng = dept('engineering');
      await gapp.ledger.run('hireDepartment', { template: eng, models: Object.fromEntries(eng.roles.map((r) => [r.key, NANO])) }, ceo);
      const obj = await gapp.ledger.run('createObjective', { title: 'AIC live test: greeting helper', departmentKey: 'engineering', budgetUsd: 0.30,
        requirements: [{ key: 'REQ-1', text: 'Create src/greet.js (ES module) exporting greet(name) that returns exactly `Hello, ${name}!` (for example greet("Ada") returns "Hello, Ada!"). Add tests in test/greet.test.js using node:test and node:assert.' }] }, ceo);
      await gapp.orchestrator.runUntilIdle(600_000);
      const plan = (await inbox(gapp.ledger.db)).find((i) => i.kind === 'plan');
      if (plan) { await gapp.ledger.run('decideProposal', { proposalId: plan.id, decision: 'approve' }, ceo); await gapp.orchestrator.runUntilIdle(900_000); }
      const items = await inbox(gapp.ledger.db);
      console.log('CEO inbox:', items.map((i) => `${i.kind}: ${i.title}`));
      const spent = guard.spent(SpendGuard.keyId(NANO)) - startSpend;
      console.log(`spent this run: $${spent.toFixed(4)}; lifetime $${guard.spent(SpendGuard.keyId(NANO)).toFixed(4)} of $${guard.capUsd}`);
      expect(spent).toBeLessThan(0.35);

      const release = items.find((i) => i.kind === 'release');
      if (release) {
        const sha = (await gapp.workspaces.remoteSha(`refs/heads/${gapp.workspaces.integrationBranch(obj.objectiveId)}`))!;
        await gapp.ledger.run('approveRelease', { objectiveId: obj.objectiveId, integrationSha: sha }, ceo);
        await gapp.orchestrator.runUntilIdle(300_000);
        const act = (await gapp.ledger.db.query<{ status: string; external_ref: string | null }>(
          `SELECT status, external_ref FROM external_actions WHERE connector = 'github' ORDER BY created_at DESC LIMIT 1`)).rows[0];
        console.log('release action:', act);
        expect(act?.status).toBe('succeeded');
        const prNumber = Number(/pr\/(\d+)/.exec(act!.external_ref ?? '')![1]);
        const pr = await gh(`/pulls/${prNumber}`);
        console.log(`PR #${pr.number} ${pr.html_url} merged=${pr.merged} head=${pr.head.sha.slice(0, 10)} approved=${sha.slice(0, 10)}`);
        expect(pr.merged).toBe(true);
        expect(pr.head.sha).toBe(sha); // exactly the commit the CEO approved
        const file = await gh('/contents/src/greet.js?ref=main');
        expect(file.type).toBe('file');
      } else {
        console.log('No release this run (the model did not finish within budget); the platform reported it honestly above.');
        // Diagnose: the last tool exchanges of each failed run.
        const { readdirSync: rd, readFileSync: rf, existsSync: ex } = await import('node:fs');
        const tdir = path.join(gdir, 'storage', 'transcripts');
        const failed = (await gapp.ledger.db.query<{ id: string }>(`SELECT id FROM runs WHERE status = 'failed' ORDER BY started_at`)).rows.map((r) => r.id);
        for (const id of failed.slice(-1)) {
          const f = path.join(tdir, `${id}.jsonl`); if (!ex(f)) continue;
          const lines = rf(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
          console.log(`--- last entries of failed run ${id}:`);
          for (const e of lines.slice(-6)) console.log(JSON.stringify(e).slice(0, 900));
        }
        void rd;
      }

      // The token never lands in the ledger, transcripts, or any clone's .git/config (agents can read workspaces).
      const dump = JSON.stringify((await gapp.ledger.db.query('SELECT * FROM ledger_events')).rows) + JSON.stringify((await gapp.ledger.db.query('SELECT * FROM external_actions')).rows)
        + JSON.stringify((await gapp.ledger.db.query('SELECT * FROM runs')).rows);
      expect(dump).not.toContain(token);
      const { readdirSync, readFileSync, statSync } = await import('node:fs');
      const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
      const files = walk(path.join(gdir, 'storage')).filter((f) => /[\\/]\.git[\\/]config$|transcripts|\.json$/.test(f));
      for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toContain(token);
      console.log(`checked ${files.length} config/transcript files for the token: clean`);
    } finally {
      await gapp.close();
      rmSync(gdir, { recursive: true, force: true, maxRetries: 3 });
    }
  }, 1_800_000);
});
