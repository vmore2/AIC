import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { ConfigSchema } from '../src/config/config.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import { DomainError } from '../src/ledger/engine.js';
import { dept } from './helpers.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-conv-'));
let app: App;
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

describe('CEO ↔ team lead conversation becomes a proposal only after confirmation', () => {
  it('lead drafts a directive; nothing changes until the CEO confirms the exact payload', async () => {
    app = await createApp(ConfigSchema.parse({
      company: { name: 'Talk Co' }, database: { local_path: path.join(dir, 'db') },
      models: { profiles: [{ key: 'scripted', provider: 'scripted', model: 's', family: 'f' }], default: 'scripted' },
      code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'),
    }));
    const { ledger, orchestrator } = app;
    const { ceoUserId } = await ledger.run('bootstrapCompany', { companyName: 'Talk Co', ceoName: 'Casey', defaultMode: 'M4' }, SYSTEM);
    const ceo: Principal = { type: 'user', id: ceoUserId, stepUp: true };
    const research = dept('research');
    const scripted = app.config.models.profiles[0]!;
    const hired = await ledger.run('hireDepartment', { template: research, models: Object.fromEntries(research.roles.map((r) => [r.key, scripted])) }, ceo);
    const lead = hired.employees.find((e) => e.role === 'research_lead')!;

    const { conversationId } = await ledger.run('startConversation', { employeeId: lead.id }, ceo);
    const { runId } = await ledger.run('postMessage', { conversationId, body: 'I need a competitive analysis of the top three project-management tools for small agencies.' }, ceo);
    const turn = await orchestrator.converse(runId);
    expect(turn.reply, turn.reply).toMatch(/drafted this as a proposal/i);
    expect(turn.directives).toHaveLength(1);

    // Nothing has happened yet.
    expect((await ledger.db.query('SELECT 1 FROM objectives')).rows).toHaveLength(0);

    // The lead cannot confirm its own proposal; a stale/forged hash is refused.
    const leadPrincipal: Principal = { type: 'employee', id: lead.id, runId, epoch: 0 };
    await expect(ledger.run('confirmDirective', { directiveId: turn.directives[0]!.id, payloadSha256: turn.directives[0]!.payloadSha256 }, leadPrincipal))
      .rejects.toBeInstanceOf(DomainError);
    await expect(ledger.run('confirmDirective', { directiveId: turn.directives[0]!.id, payloadSha256: 'f'.repeat(64) }, ceo)).rejects.toThrow(/differs/);

    const confirmed = await ledger.run('confirmDirective', { directiveId: turn.directives[0]!.id, payloadSha256: turn.directives[0]!.payloadSha256 }, ceo);
    expect(confirmed.status).toBe('applied');
    const [obj] = (await ledger.db.query<{ id: string; status: string }>('SELECT id, status FROM objectives')).rows;
    expect(obj!.status).toBe('planning');

    // The lead then plans; with Plan Gates the plan waits for the CEO.
    await orchestrator.runUntilIdle(60_000);
    const planning = (await ledger.db.query<{ status: string }>(`SELECT status FROM tasks WHERE objective_id = $1 AND kind = 'planning'`, [obj!.id])).rows[0]!;
    expect(planning.status).toBe('awaiting_acceptance');
    const msgs = (await ledger.db.query('SELECT author_type FROM messages WHERE conversation_id = $1 ORDER BY seq', [conversationId])).rows;
    expect(msgs.map((m) => (m as { author_type: string }).author_type)).toEqual(['user', 'employee']);
  }, 120_000);
});
