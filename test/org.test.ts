import { describe, expect, it } from 'vitest';
import { loadDepartments, validateDepartment } from '../src/org/validate.js';
import type { Department } from '../src/org/schema.js';

const { departments, findings } = loadDepartments('templates/departments');
const byKey = (k: string) => structuredClone(departments.find((d) => d.key === k)!) as Department;
const rules = (d: Department) => validateDepartment(d).filter((f) => f.level === 'error').map((f) => f.rule);
const role = (d: Department, k: string) => d.roles.find((r) => r.key === k)!;

describe('shipped department templates', () => {
  it('load and validate with no errors', () => {
    expect(departments.length).toBeGreaterThanOrEqual(10);
    expect(findings.filter((f) => f.level === 'error')).toEqual([]);
  });

  it('every department has a reviewer outside the producer chain and a head reporting to the CEO', () => {
    for (const d of departments) {
      expect(d.roles.some((r) => r.category === 'reviewer')).toBe(true);
      expect(d.structure.find((s) => s.role === d.head)?.reports_to).toBe('ceo');
    }
  });
});

describe('architecture rules reject unsafe team designs', () => {
  it('Rule of Two: a builder that reads untrusted web content is rejected', () => {
    const d = byKey('engineering');
    role(d, 'software_engineer').tools.push('web.fetch');
    expect(rules(d)).toContain('profile_untrusted');
  });

  it('Rule of Two: the trifecta without the mixed profile is rejected', () => {
    const d = byKey('customer_support');
    role(d, 'support_agent').rule_of_two_profile = 'communicator';
    expect(rules(d)).toEqual(expect.arrayContaining(['rule_of_two']));
  });

  it('mixed profile may only communicate through approval-gated tools', () => {
    const d = byKey('customer_support');
    role(d, 'support_agent').tools.push('chat.post_internal', 'calendar.schedule');
    expect(rules(d)).toContain('mixed_profile_gated');
  });

  it('reviewers cannot hold side-effecting tools', () => {
    const d = byKey('engineering');
    role(d, 'code_reviewer').tools.push('repo.commit_and_push');
    expect(rules(d)).toContain('reviewer_readonly');
  });

  it('a reviewer inside the producer management chain is rejected', () => {
    const d = byKey('engineering');
    role(d, 'code_reviewer').can_manage = true;
    role(d, 'code_reviewer').category = 'reviewer';
    d.structure = d.structure.map((s) => (s.role === 'software_engineer' ? { ...s, reports_to: 'code_reviewer' } : s));
    expect(rules(d)).toContain('reviewer_outside_chain');
  });

  it('artifact-producing roles need a deterministic criterion', () => {
    const d = byKey('engineering');
    role(d, 'software_engineer').criteria_templates = role(d, 'software_engineer').criteria_templates.filter((c) => c.kind === 'rubric_review');
    expect(rules(d)).toContain('deterministic_anchor');
  });

  it('hierarchies deeper than three layers below the CEO are rejected', () => {
    const d = byKey('engineering');
    for (const k of ['software_engineer', 'qa_engineer']) role(d, k).can_manage = true;
    d.structure = [
      { role: 'engineering_lead', count: 1, reports_to: 'ceo' },
      { role: 'software_engineer', count: 1, reports_to: 'engineering_lead' },
      { role: 'qa_engineer', count: 1, reports_to: 'software_engineer' },
      { role: 'code_reviewer', count: 1, reports_to: 'qa_engineer' },
    ];
    expect(rules(d)).toContain('max_depth');
  });

  it('non-managers cannot hold delegation tools', () => {
    const d = byKey('engineering');
    role(d, 'software_engineer').tools.push('ledger.create_subtask');
    expect(rules(d)).toContain('manager_tools');
  });

  it('work affecting individuals requires a human criterion', () => {
    const d = byKey('people_ops');
    const r = role(d, 'people_ops_specialist');
    r.affects_individuals = true;
    r.criteria_templates = r.criteria_templates.filter((c) => c.independence !== 'human');
    expect(rules(d)).toContain('individuals_human');
  });

  it('high-risk departments need a human gate in every workflow', () => {
    const d = byKey('finance');
    d.workflows[0]!.stages = d.workflows[0]!.stages.map((s) => ({ ...s, gate: 'none' as const }));
    expect(rules(d)).toContain('human_gate');
  });
});
