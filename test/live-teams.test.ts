// LIVE scenarios with a real model (opt-in, spend-capped): a multi-requirement engineering objective
// shaped by CEO instructions, and a non-engineering team (Product Design) producing documents.
//   AIC_LIVE=1 AIC_LIVE_SCENARIO=engineering|design npx vitest run test/live-teams.test.ts
// The test plays the CEO: approves plans, accepts verified work, answers questions — then prints what
// the team actually produced so a human can judge it.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDotEnv } from '../src/config/env.js';
import { ConfigSchema, type ModelProfile } from '../src/config/config.js';
import { createApp, type App } from '../src/app.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import { SpendGuard } from '../src/runtime/spendGuard.js';
import { inbox } from '../src/reports/views.js';
import { dept } from './helpers.js';

loadDotEnv();
const LIVE = process.env['AIC_LIVE'] === '1' && !!process.env['OPENAI_API_KEY'] && !!process.env['AIC_SPEND_CAP_USD'];
const SCENARIO = process.env['AIC_LIVE_SCENARIO'] ?? '';
const ALL_MINI = process.env['AIC_LIVE_MODEL'] === 'mini';
const MODEL: ModelProfile = ALL_MINI ? {
  key: 'mini', provider: 'openai_compatible', model: 'gpt-4.1-mini', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY',
  family: 'openai', context_tokens: 128000, structured_output: true, tool_calling: true, price_per_million: { input: 0.40, output: 1.60 },
} : {
  key: 'nano', provider: 'openai_compatible', model: 'gpt-4.1-nano', base_url: 'https://api.openai.com/v1', api_key_env: 'OPENAI_API_KEY',
  family: 'openai', context_tokens: 128000, structured_output: true, tool_calling: true, price_per_million: { input: 0.10, output: 0.40 },
};
// Planning is the hardest job: optionally give only the lead a stronger (still cheap) model. AIC_LIVE_LEAD_MODEL=mini
const LEAD: ModelProfile = process.env['AIC_LIVE_LEAD_MODEL'] === 'mini' && !ALL_MINI
  ? { ...MODEL, key: 'mini', model: 'gpt-4.1-mini', price_per_million: { input: 0.40, output: 1.60 } } : MODEL;

async function company(teamKey: string): Promise<{ app: App; ceo: Principal; dir: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), `aic-live-${teamKey}-`));
  const app = await createApp(ConfigSchema.parse({
    company: { name: 'Live Scenario Co' }, database: { local_path: path.join(dir, 'db') },
    models: { profiles: LEAD === MODEL ? [MODEL] : [MODEL, LEAD], default: MODEL.key },
    code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'), teams_path: path.join(dir, 'teams'),
    sandbox: { kind: 'docker', docker: { image: 'node:22-bookworm-slim', memory: '1g', cpus: 1, network: 'none' } },
  }), { log: (m) => console.log(`  · ${m}`) });
  const b = await app.ledger.run('bootstrapCompany', { companyName: 'Live Scenario Co', ceoName: 'CEO', defaultMode: 'M4', projectSettings: { test_command: 'node --test' } }, SYSTEM);
  const ceo: Principal = { type: 'user', id: b.ceoUserId, stepUp: true };
  const d = dept(teamKey);
  await app.ledger.run('hireDepartment', { template: d, models: Object.fromEntries(d.roles.map((r) => [r.key, ['manager', 'executive'].includes(r.category) ? LEAD : MODEL])) }, ceo);
  return { app, ceo, dir };
}

/** Play the CEO until the team finishes or stops making progress. Returns a log of the decisions made. */
async function steer(app: App, ceo: Principal, rounds = 6): Promise<string[]> {
  const decisions: string[] = [];
  for (let round = 0; round < rounds; round++) {
    await app.orchestrator.runUntilIdle(900_000);
    let acted = false;
    for (const it of await inbox(app.ledger.db)) {
      if (it.kind === 'plan') { await app.ledger.run('decideProposal', { proposalId: it.id, decision: 'approve' }, ceo); decisions.push(`approved ${it.title}`); acted = true; }
      else if (it.kind === 'acceptance') {
        const sub = (await app.ledger.db.query<{ submission_sha256: string }>(`SELECT submission_sha256 FROM submissions WHERE task_id = $1 AND status = 'open'`, [it.id])).rows[0];
        if (sub) { await app.ledger.run('acceptTask', { taskId: it.id, submissionSha256: sub.submission_sha256, rationale: 'live-test CEO acceptance after reading the evidence' }, ceo); decisions.push(`accepted ${it.title}`); acted = true; }
      } else if (it.kind === 'escalation') {
        await app.ledger.run('resolveEscalation', { escalationId: it.id, answer: 'Use your best judgment within the written requirements; keep it simple.' }, ceo);
        decisions.push(`answered ${it.title}`); acted = true;
      }
    }
    if (!acted) break;
  }
  return decisions;
}

async function report(app: App, objectiveId: string, files: string[]) {
  const tasks = (await app.ledger.db.query<{ title: string; role_key: string; status: string; attempt: number; assurance_label: string | null }>(
    `SELECT t.title, e.role_key, t.status, t.attempt, t.assurance_label FROM tasks t LEFT JOIN employees e ON e.id = t.owner_employee_id
     WHERE t.objective_id = $1 AND t.status NOT IN ('cancelled','superseded') ORDER BY t.created_at`, [objectiveId])).rows;
  console.log('TASKS:\n' + tasks.map((t) => `  - [${t.status}] ${t.title} (${t.role_key}, attempt ${t.attempt}${t.assurance_label ? `, ${t.assurance_label}` : ''})`).join('\n'));
  const fails = (await app.ledger.db.query<{ statement: string; result: string; details: unknown }>(
    `SELECT c.statement, e.result, e.details FROM evidence e JOIN criteria c ON c.id = e.criterion_id JOIN tasks t ON t.id = e.task_id
     WHERE t.objective_id = $1 AND e.result <> 'pass' ORDER BY e.created_at`, [objectiveId])).rows;
  console.log(`CHECKS THAT FAILED OR WERE INCONCLUSIVE (${fails.length}):\n` + fails.map((f) => `  - [${f.result}] ${f.statement}: ${JSON.stringify(f.details).slice(0, 300)}`).join('\n'));
  // For failed runs, show what the platform told the model last (validation errors, denials).
  const { existsSync, readFileSync } = await import('node:fs');
  const failedRuns = (await app.ledger.db.query<{ id: string; failure_reason: string }>(
    `SELECT r.id, r.failure_reason FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.objective_id = $1 AND r.status = 'failed' ORDER BY r.started_at`, [objectiveId])).rows;
  for (const r of failedRuns.slice(-1)) {
    const f = path.join(app.config.storage_path, 'transcripts', `${r.id}.jsonl`);
    if (!existsSync(f)) continue;
    const results = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type?: string; name?: string; ok?: boolean; content?: string })
      .filter((e) => e.type === 'tool' && e.ok === false);
    console.log(`LAST ERRORS GIVEN TO THE MODEL in ${r.id} (${r.failure_reason}):\n` + results.slice(-3).map((e) => `  - ${e.name}: ${String(e.content).slice(0, 900)}`).join('\n'));
  }
  const obj = (await app.ledger.db.query<{ status: string }>('SELECT status FROM objectives WHERE id = $1', [objectiveId])).rows[0]!;
  console.log(`OBJECTIVE: ${obj.status}`);
  const sha = await app.workspaces.remoteSha(`refs/heads/${app.workspaces.integrationBranch(objectiveId)}`);
  if (sha && app.config.code_hosting.kind === 'local') {
    const { git } = await import('../src/execution/codeHost.js');
    console.log(`DELIVERED FILES: ${(await git(app.config.code_hosting.path, ['ls-tree', '-r', '--name-only', sha])).split('\n').join(', ')}`);
  }
  const out: Record<string, string | null> = {};
  for (const f of files) {
    out[f] = sha ? await app.workspaces.showFile(sha, f) : null;
    console.log(`==== ${f} (integration branch)\n${out[f]?.slice(0, 2500) ?? '(not delivered)'}`);
  }
  return { tasks, obj, out };
}

describe.skipIf(!LIVE)('live scenarios (spend-capped)', () => {
  it.skipIf(SCENARIO !== 'engineering')('engineering: a multi-requirement shopping cart, shaped by CEO instructions', async () => {
    const { app, ceo, dir } = await company('engineering');
    const guard = SpendGuard.fromEnv()!; const start = guard.spent(SpendGuard.keyId(MODEL));
    console.log(`MODELS: lead=${LEAD.model}, everyone else=${MODEL.model}`);
    try {
      await app.ledger.run('setInstructions', { scopeType: 'company', body: 'Keep code simple and readable. Use only the Node.js standard library — no npm dependencies.' }, ceo);
      await app.ledger.run('setInstructions', { scopeType: 'role', departmentKey: 'engineering', roleKey: 'software_engineer', body: 'Put a JSDoc comment (/** ... */) directly above every exported function.' }, ceo);
      const obj = await app.ledger.run('createObjective', { title: 'Shopping cart module', departmentKey: 'engineering', budgetUsd: 0.5, requirements: [
        { key: 'REQ-1', text: 'Create src/cart.js (ES module) exporting createCart(). The cart has add(sku, priceCents, qty = 1), remove(sku) and total(). Money is integer cents; total() returns the sum of price × quantity in cents. Adding an existing sku increases its quantity.' },
        { key: 'REQ-2', text: 'add() throws an Error if qty is not a positive integer or priceCents is not a non-negative integer.' },
        { key: 'REQ-3', text: 'The cart has applyDiscount(code). "SAVE10" makes total() return 10% less, rounded down to whole cents. Any other code throws an Error.' },
        { key: 'REQ-4', text: 'Tests in test/cart.test.js (node:test + node:assert) cover REQ-1 to REQ-3, including the error cases.' },
      ] }, ceo);
      const decisions = await steer(app, ceo);
      console.log('CEO DECISIONS:', decisions);
      const { out } = await report(app, obj.objectiveId, ['src/cart.js', 'test/cart.test.js']);
      const spent = guard.spent(SpendGuard.keyId(MODEL)) - start;
      console.log(`SPENT: $${spent.toFixed(4)} (lifetime $${guard.spent(SpendGuard.keyId(MODEL)).toFixed(4)} of $${guard.capUsd})`);
      const code = out['src/cart.js'];
      if (code) console.log(`INSTRUCTION CHECK — JSDoc above exports: ${/\/\*\*[\s\S]*?\*\/\s*export/.test(code) ? 'yes' : 'NO'}; npm imports: ${/from ['"](?!node:|\.)/.test(code) ? 'YES (violates)' : 'none'}`);
      expect(spent).toBeLessThan(0.55);
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  }, 2_400_000);

  it.skipIf(SCENARIO !== 'design')('product design: a non-engineering team delivers a design spec and interface copy', async () => {
    const { app, ceo, dir } = await company('product_design');
    const guard = SpendGuard.fromEnv()!; const start = guard.spent(SpendGuard.keyId(MODEL));
    console.log(`MODELS: lead=${LEAD.model}, everyone else=${MODEL.model}`);
    try {
      await app.ledger.run('setInstructions', { scopeType: 'company', body: 'Our customers are small neighbourhood bakeries and their regulars, many of them older. Plain, warm language; large tap targets.' }, ceo);
      const obj = await app.ledger.run('createObjective', { title: 'Online ordering flow for a bakery', departmentKey: 'product_design', budgetUsd: 0.4, requirements: [
        { key: 'REQ-1', text: 'Design the flow for ordering ahead: browse today\'s menu, add items, pick a pickup time slot, confirm. Payment happens at pickup.' },
        { key: 'REQ-2', text: 'Every screen meets WCAG 2.2 AA: text contrast, focus order, and labels for screen readers are specified.' },
        { key: 'REQ-3', text: 'Interface copy for every screen, including the "sold out" and "no pickup slots left today" states.' },
      ] }, ceo);
      const decisions = await steer(app, ceo);
      console.log('CEO DECISIONS:', decisions);
      await report(app, obj.objectiveId, ['design/SPEC.md', 'copy/COPY.md']);
      const spent = guard.spent(SpendGuard.keyId(MODEL)) - start;
      console.log(`SPENT: $${spent.toFixed(4)} (lifetime $${guard.spent(SpendGuard.keyId(MODEL)).toFixed(4)} of $${guard.capUsd})`);
      expect(spent).toBeLessThan(0.45);
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  }, 2_400_000);
});
