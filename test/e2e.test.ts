import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { ConfigSchema } from '../src/config/config.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import { verifyChain } from '../src/ledger/engine.js';
import { git } from '../src/execution/codeHost.js';
import { dept } from './helpers.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-e2e-'));
let app: App;
const logs: string[] = [];

afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

const status = async (q: App['ledger']['db'], sql: string, params: unknown[] = []) => (await q.query<Record<string, unknown>>(sql, params)).rows;

describe('end to end: CEO → team lead proposal → execution → independent verification → release', () => {
  it('runs a full engineering objective on customer-provided (local) infrastructure', async () => {
    const config = ConfigSchema.parse({
      company: { name: 'E2E Co' },
      database: { local_path: path.join(dir, 'db') },
      models: { profiles: [
        { key: 'scripted', provider: 'scripted', model: 'scripted', family: 'family-a' },
        { key: 'scripted-reviewer', provider: 'scripted', model: 'scripted', family: 'family-b' },
      ], default: 'scripted', assignments: { code_reviewer: 'scripted-reviewer' } },
      code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') },
      storage_path: path.join(dir, 'storage'),
      sandbox: { allow_unisolated_local: true },
    });
    app = await createApp(config, { log: (m) => logs.push(m) });
    const { ledger, orchestrator } = app;
    const db = ledger.db;

    const { ceoUserId } = await ledger.run('bootstrapCompany', { companyName: 'E2E Co', ceoName: 'Casey', defaultMode: 'M4' }, SYSTEM);
    const ceo: Principal = { type: 'user', id: ceoUserId, stepUp: true };
    const eng = dept('engineering');
    const models = Object.fromEntries(eng.roles.map((r) => [r.key, config.models.profiles.find((p) => p.key === (config.models.assignments[r.key] ?? 'scripted'))!]));
    await ledger.run('hireDepartment', { template: eng, models }, ceo);

    const obj = await ledger.run('createObjective', {
      title: 'URL slugs', departmentKey: 'engineering', budgetUsd: 100,
      requirements: [{ key: 'REQ-1', text: 'Provide slugify(text): lowercase words joined by single hyphens, punctuation removed, no leading or trailing hyphens.' }],
      settings: { test_command: 'node --test' },
    }, ceo);

    // 1) The lead plans and proposes; the platform validates; work stops at the CEO gate (Plan Gates mode).
    await orchestrator.runUntilIdle(60_000);
    const [planning] = await status(db, 'SELECT status FROM tasks WHERE id = $1', [obj.planningTaskId]);
    expect(planning!['status']).toBe('awaiting_acceptance');
    const [proposal] = await status(db, `SELECT id, content FROM proposals WHERE task_id = $1 AND status = 'submitted'`, [obj.planningTaskId]);
    expect((proposal!['content'] as { tasks: unknown[] }).tasks.length).toBe(2); // implementation + independent QA

    // 2) CEO approves the proposal → tasks materialize and execute.
    await ledger.run('decideProposal', { proposalId: String(proposal!['id']), decision: 'approve', rationale: 'Good plan' }, ceo);
    await orchestrator.runUntilIdle(120_000);

    const tasks = await status(db, `SELECT id, title, status, attempt, assurance_label, owner_employee_id FROM tasks WHERE parent_task_id = $1 ORDER BY created_at`, [obj.planningTaskId]);
    expect(tasks.map((t) => t['status'])).toEqual(['accepted', 'accepted']);
    const impl = tasks.find((t) => String(t['title']).startsWith('Deliver'))!; // same-transaction rows share created_at
    // Attempt 1 claimed success with a bug; deterministic tests caught it; attempt 2 fixed it.
    expect(impl['attempt']).toBe(2);
    expect(impl['assurance_label']).toBe('A-det+rev');
    const claims = await status(db, `SELECT s.status, s.claim FROM submissions s WHERE s.task_id = $1 ORDER BY s.created_at`, [impl['id']]);
    expect(claims[0]!['status']).toBe('rejected');
    expect(JSON.stringify(claims[0]!['claim'])).toContain('"met"'); // the false claim is preserved as a claim
    const failed = await status(db, `SELECT e.result, e.independence FROM evidence e JOIN submissions s ON s.id = e.submission_id WHERE s.task_id = $1 AND e.result = 'fail'`, [impl['id']]);
    expect(failed[0]).toMatchObject({ result: 'fail', independence: 'sandboxed_runner' });
    // The independent reviewer ran on a different model family than the producer.
    const review = await status(db, `SELECT e.independence, e.family_differs FROM evidence e WHERE e.task_id = $1 AND e.verifier_type = 'employee'`, [impl['id']]);
    expect(review.at(-1)).toMatchObject({ independence: 'different_lineage_model', family_differs: true });

    // 3) Objective complete → CEO approves release of the exact integration commit → merged to main.
    const [o] = await status(db, 'SELECT status FROM objectives WHERE id = $1', [obj.objectiveId]);
    expect(o!['status']).toBe('completed');
    const integrationSha = await app.workspaces.remoteSha(`refs/heads/${app.workspaces.integrationBranch(obj.objectiveId)}`);
    expect(integrationSha).toBeTruthy();
    await ledger.run('approveRelease', { objectiveId: obj.objectiveId, integrationSha: integrationSha! }, ceo);
    await orchestrator.runUntilIdle(60_000);
    const mainSha = await app.workspaces.remoteSha('refs/heads/main');
    const probe = path.join(dir, 'check');
    await git(dir, ['clone', '--quiet', config.code_hosting.kind === 'local' ? config.code_hosting.path : '', probe]);
    const files = await git(probe, ['ls-files']);
    expect(files).toContain('src/slugify.js');
    expect(files).toContain('test/slugify.acceptance.test.js');
    expect(mainSha).not.toBeNull();

    // 4) The audit chain is intact; every agent action went through the gateway.
    expect((await verifyChain(db)).ok).toBe(true);
    const [tc] = await status(db, `SELECT count(*)::int AS n FROM tool_calls`);
    expect(Number(tc!['n'])).toBeGreaterThan(5);
  }, 240_000);
});
