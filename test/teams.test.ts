import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { buildServer } from '../src/api/server.js';
import { ConfigSchema } from '../src/config/config.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import { loadCatalog } from '../src/org/catalog.js';
import { compileTeam, starterSpec } from '../src/org/teamSpec.js';
import { validateDepartment } from '../src/org/validate.js';

const growth = {
  team: 'growth_marketing', name: 'Growth Marketing',
  purpose: 'Find and test growth channels with clear, reviewed briefs and measurable experiments.',
  mode: 'plan_gates', risk: 'standard',
  roles: [
    { title: 'Growth Lead', lead: true, does: 'Turns growth goals into experiment plans with measurable success criteria.' },
    { title: 'Growth Analyst', count: 2, does: 'Designs experiments and writes a brief with the hypothesis, setup, and success metric.',
      works_with: ['documents', 'analytics'], delivers: [{ document: 'growth/EXPERIMENT.md', sections: ['Hypothesis', 'Setup', 'Success Metric'] }],
      human_judges: 'The CEO approves the experiment before launch' },
    { title: 'Growth Reviewer', reviews: ['Growth Analyst'], does: 'Independently checks each brief for a testable hypothesis and an honest metric.' },
  ],
};

describe('team specs: define the roles, the platform derives the rest', () => {
  it('the starter scaffold compiles and passes every architecture rule', () => {
    const r = compileTeam(parseYaml(starterSpec('ops_research', 'Ops Research')));
    expect(r.errors).toEqual([]);
    expect(validateDepartment(r.department!).filter((f) => f.level === 'error')).toEqual([]);
  });

  it('derives reporting lines, tools, criteria, review chain, profile, and workflow gates', () => {
    const { department: d, errors } = compileTeam(growth);
    expect(errors).toEqual([]);
    const analyst = d!.roles.find((r) => r.key === 'growth_analyst')!;
    expect(d!.structure.find((s) => s.role === 'growth_analyst')).toMatchObject({ reports_to: 'growth_lead', count: 2 });
    expect(d!.structure.find((s) => s.role === 'growth_reviewer')!.reports_to).toBe('ceo'); // outside the producer chain
    expect(analyst.tools).toEqual(expect.arrayContaining(['analytics.query', 'ledger.submit_work']));
    expect(analyst.criteria_templates.map((c) => c.kind)).toEqual(['deterministic', 'deterministic', 'rubric_review', 'human_judgment']);
    expect(analyst.reviewer_role).toBe('growth_reviewer');
    const reviewer = d!.roles.find((r) => r.key === 'growth_reviewer')!;
    expect(reviewer.tools).not.toContain('fs.write');
    expect(d!.workflows[0]!.stages.find((s) => s.owner_role === 'growth_analyst')!.gate).toBe('human_acceptance');
    expect(validateDepartment(d!).filter((f) => f.level === 'error')).toEqual([]);
  });

  it('gives friendly errors for missing lead, unknown reviewed roles, and vague roles', () => {
    const r = compileTeam({ ...growth, roles: [{ title: 'A', does: 'short' }, { title: 'Checker', reviews: ['Nobody'], does: 'Reviews things that do not exist in this team.' }] });
    expect(r.errors.join('\n')).toMatch(/full sentence/);
    const r2 = compileTeam({ ...growth, roles: growth.roles.map((x) => ({ ...x, lead: false })) });
    expect(r2.errors.join('\n')).toMatch(/Exactly one role must have "lead: true"/);
    const r3 = compileTeam({ ...growth, roles: [...growth.roles.slice(0, 2), { title: 'Checker', reviews: ['Nobody'], does: 'Reviews things that do not exist in this team.' }] });
    expect(r3.errors.join('\n')).toMatch(/"Nobody", which is not a role/);
  });

  it('applies Rule-of-Two and human floors automatically', () => {
    const { department: d, notes, errors } = compileTeam({
      ...growth, risk: 'high',
      roles: [growth.roles[0], { title: 'Outreach Specialist', does: 'Researches prospects on the web and emails them from the CRM after approval.',
        works_with: ['web_research', 'crm', 'send_email'], affects_people: true }, { ...growth.roles[2]!, reviews: ['Outreach Specialist'] }],
    });
    expect(errors).toEqual([]);
    const outreach = d!.roles.find((r) => r.key === 'outreach_specialist')!;
    expect(outreach.rule_of_two_profile).toBe('mixed');
    expect(notes.join('\n')).toMatch(/Rule of Two/);
    expect(outreach.criteria_templates.some((c) => c.independence === 'human')).toBe(true);
    expect(d!.workflows[0]!.stages.some((s) => s.gate === 'human_acceptance')).toBe(true);
    expect(validateDepartment(d!).filter((f) => f.level === 'error')).toEqual([]);
  });

  it('the recommended catalog includes the short-spec Design and HR teams, all valid', () => {
    const c = loadCatalog(path.join(os.tmpdir(), 'no-custom-teams'));
    for (const k of ['product_design', 'people_ops']) expect(c.get(k)).toMatchObject({ source: 'recommended', format: 'team_spec', errors: [] });
    expect(c.entries.every((e) => e.errors.length === 0)).toBe(true);
  });
});

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-teams-'));
let app: App;
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

describe('team builder API and a custom team doing real work', () => {
  it('saves a custom team from the builder, hires it, and runs an objective to verified completion', async () => {
    app = await createApp(ConfigSchema.parse({
      company: { name: 'Builder Co' }, database: { local_path: path.join(dir, 'db') },
      models: { profiles: [{ key: 'scripted', provider: 'scripted', model: 's', family: 'a' }, { key: 'rev', provider: 'scripted', model: 's', family: 'b' }],
        default: 'scripted', assignments: { growth_reviewer: 'rev' } },
      code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'),
      teams_path: path.join(dir, 'teams'), sandbox: { allow_unisolated_local: true },
    }));
    const b = await app.ledger.run('bootstrapCompany', { companyName: 'Builder Co', ceoName: 'C', defaultMode: 'M4' }, SYSTEM);
    const ceo: Principal = { type: 'user', id: b.ceoUserId, stepUp: true };
    const server = buildServer(app, 'tok');
    const call = (method: 'GET' | 'POST', url: string, payload?: unknown) => server.inject({ method, url, payload: payload as object, headers: { 'x-aic-token': 'tok' } });

    expect((await server.inject({ method: 'GET', url: '/api/catalog' })).statusCode).toBe(401);
    const bad = await call('POST', '/api/teams', { spec: { ...growth, roles: growth.roles.slice(1) } });
    expect(bad.statusCode).toBe(400);
    const saved = await call('POST', '/api/teams', { spec: growth });
    expect(saved.statusCode).toBe(200);
    expect(existsSync(path.join(dir, 'teams', 'growth_marketing.yaml'))).toBe(true);
    const catalog = (await call('GET', '/api/catalog')).json() as { key: string; source: string; hired: boolean }[];
    expect(catalog.find((t) => t.key === 'growth_marketing')).toMatchObject({ source: 'custom', hired: false });
    const hired = await call('POST', '/api/catalog/growth_marketing/hire');
    expect(hired.statusCode).toBe(200);
    expect((hired.json() as { employees: unknown[] }).employees).toHaveLength(4);

    const obj = await app.ledger.run('createObjective', { title: 'Test referral program', departmentKey: 'growth_marketing', budgetUsd: 40,
      requirements: [{ key: 'REQ-1', text: 'Design an experiment to test a referral program for existing customers.' }] }, ceo);
    await app.orchestrator.runUntilIdle(60_000);
    const prop = (await app.ledger.db.query<{ id: string }>(`SELECT id FROM proposals WHERE task_id = $1`, [obj.planningTaskId])).rows[0]!;
    await app.ledger.run('decideProposal', { proposalId: prop.id, decision: 'approve' }, ceo);
    await app.orchestrator.runUntilIdle(120_000);

    // The analyst's brief passed the platform's document checks and the independent reviewer; a human must still accept.
    const task = (await app.ledger.db.query<{ id: string; status: string }>(`SELECT id, status FROM tasks WHERE parent_task_id = $1`, [obj.planningTaskId])).rows[0]!;
    expect(task.status).toBe('awaiting_acceptance');
    const sub = (await app.ledger.db.query<{ submission_sha256: string }>(`SELECT submission_sha256 FROM submissions WHERE task_id = $1 AND status = 'open'`, [task.id])).rows[0]!;
    await app.ledger.run('acceptTask', { taskId: task.id, submissionSha256: sub.submission_sha256, rationale: 'Approved for launch' }, ceo);
    await app.orchestrator.runUntilIdle(60_000);
    const o = (await app.ledger.db.query<{ status: string }>('SELECT status FROM objectives WHERE id = $1', [obj.objectiveId])).rows[0]!;
    expect(o.status).toBe('completed');
    const label = (await app.ledger.db.query<{ assurance_label: string }>('SELECT assurance_label FROM tasks WHERE id = $1', [task.id])).rows[0]!;
    expect(label.assurance_label).toBe('A-det+rev+human');
    await server.close();
  }, 240_000);
});
