import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { ConfigSchema } from '../src/config/config.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import { dept } from './helpers.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-cr-'));
let app: App;
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

describe('requirement changes mid-flight', () => {
  it('supersedes unaccepted work pinned to the old version and asks the lead to re-plan', async () => {
    app = await createApp(ConfigSchema.parse({
      company: { name: 'CR' }, database: { local_path: path.join(dir, 'db') },
      models: { profiles: [{ key: 'scripted', provider: 'scripted', model: 's', family: 'a' }], default: 'scripted' },
      code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'), teams_path: path.join(dir, 'teams'),
    }));
    const { ledger, orchestrator } = app;
    const b = await ledger.run('bootstrapCompany', { companyName: 'CR', ceoName: 'C', defaultMode: 'M4' }, SYSTEM);
    const ceo: Principal = { type: 'user', id: b.ceoUserId, stepUp: true };
    const research = dept('research');
    await ledger.run('hireDepartment', { template: research, models: Object.fromEntries(research.roles.map((r) => [r.key, app.config.models.profiles[0]!])) }, ceo);
    const obj = await ledger.run('createObjective', { title: 'Market scan', departmentKey: 'research', budgetUsd: 60,
      requirements: [{ key: 'REQ-1', text: 'Compare the top three competitors on pricing.' }] }, ceo);
    await orchestrator.runUntilIdle(60_000);
    const prop = (await ledger.db.query<{ id: string }>('SELECT id FROM proposals WHERE task_id = $1', [obj.planningTaskId])).rows[0]!;
    await ledger.run('decideProposal', { proposalId: prop.id, decision: 'approve' }, ceo);
    await ledger.run('materializePlan', { planningTaskId: obj.planningTaskId }, SYSTEM);
    const before = (await ledger.db.query<{ id: string; status: string }>('SELECT id, status FROM tasks WHERE parent_task_id = $1', [obj.planningTaskId])).rows;
    expect(before.every((t) => t.status === 'planned')).toBe(true);

    // An employee cannot change requirements.
    const lead = (await ledger.db.query<{ id: string }>(`SELECT id FROM employees WHERE role_key = 'research_lead'`)).rows[0]!;
    await expect(ledger.run('changeRequirement', { objectiveId: obj.objectiveId, key: 'REQ-1', text: 'Something weaker', reason: 'x' }, { type: 'employee', id: lead.id }))
      .rejects.toThrow(/Policy denied/);

    const r = await ledger.run('changeRequirement', { objectiveId: obj.objectiveId, key: 'REQ-1', text: 'Compare the top five competitors on pricing and packaging.', reason: 'Board asked for more breadth' }, ceo);
    expect(r.version).toBe(2);
    expect(r.superseded.sort()).toEqual(before.map((t) => t.id).sort());
    const versions = (await ledger.db.query<{ version: number; text: string }>('SELECT version, text FROM requirement_versions WHERE requirement_id = $1 ORDER BY version', [r.requirementId])).rows;
    expect(versions.map((v) => v.version)).toEqual([1, 2]); // history preserved

    // The lead re-plans only the changed requirement; with Plan Gates it waits for the CEO.
    await orchestrator.runUntilIdle(60_000);
    const replan = (await ledger.db.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [r.planningTaskId])).rows[0]!;
    expect(replan.status).toBe('awaiting_acceptance');
    const p2 = (await ledger.db.query<{ content: { tasks: { requirement_keys: string[] }[] } }>(`SELECT content FROM proposals WHERE task_id = $1`, [r.planningTaskId])).rows[0]!;
    expect(p2.content.tasks.flatMap((t) => t.requirement_keys)).toContain('REQ-1');

    // Adding a brand-new requirement works the same way.
    const add = await ledger.run('changeRequirement', { objectiveId: obj.objectiveId, key: 'REQ-2', text: 'Summarize each competitor\'s free tier.', reason: 'New ask' }, ceo);
    expect(add).toMatchObject({ version: 1, superseded: [] });
  }, 180_000);
});
