import { describe, expect, it } from 'vitest';
import { loadDepartments, validateDepartment } from '../src/org/validate.js';
import type { Department } from '../src/org/schema.js';
import { validatePlan } from '../src/ledger/plan.js';

const { departments, findings } = loadDepartments('templates/recommended');
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
    const r = role(d, 'people_operations_specialist');
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

describe('plan validation', () => {
  const eng = byKey('engineering');
  const ctx = { department: eng, leadRoleKey: 'engineering_lead', requirementKeys: ['REQ-1'], budgetRemaining: 1, riskFloor: 'R1' as const, settings: { test_command: 'node --test' } };
  const task = (over: object) => ({ ref: 't1', title: 'Analyze the requirement', kind: 'discovery', spec: 'Work out how to build it', owner_role: 'engineering_lead', requirement_keys: ['REQ-1'], budget_usd: 0.1, ...over });

  it('analysis-only tasks do not cover a requirement the team can deliver', () => {
    const v = validatePlan({ summary: 'Analyze first, build later', tasks: [task({})] }, ctx);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/REQ-1 is not covered by any task that delivers it — add a task owned by one of: .*software_engineer \(implementation\/remediation\)/);
  });

  it('a delivering task covers it; analysis may sit alongside', () => {
    const v = validatePlan({ summary: 'Analyze, then build it', tasks: [task({}), task({ ref: 't2', title: 'Build it', kind: 'implementation', owner_role: 'software_engineer', depends_on: ['t1'] })] }, ctx);
    expect(v.errors).toEqual([]);
    expect(v.coverage['REQ-1']).toEqual(['t2']);
  });
});

describe('plan criteria must be verifiable', () => {
  const eng = byKey('engineering');
  const ctx = { department: eng, leadRoleKey: 'engineering_lead', requirementKeys: ['REQ-1'], budgetRemaining: 1, riskFloor: 'R1' as const, settings: { test_command: 'node --test' } };
  const task = (criteria: object[]) => ({ ref: 'impl', title: 'Build the cart', kind: 'implementation', spec: 'Implement the cart module', owner_role: 'software_engineer', requirement_keys: ['REQ-1'], budget_usd: 0.1, criteria });

  it('refuses an "automatic" criterion with no way to check it, and says how to fix it', () => {
    const v = validatePlan({ summary: 'Build the cart module', tasks: [task([{ kind: 'deterministic', statement: 'src/cart.js exists and exports createCart', independence: 'platform' }])] }, ctx);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/has no check the platform can run\. Add "check": \{"type": "file_exists"/);
  });

  it('accepts the same criterion with a check, or handed to the reviewer', () => {
    const ok1 = validatePlan({ summary: 'Build the cart module', tasks: [task([{ kind: 'deterministic', statement: 'src/cart.js exists', independence: 'platform', check: { type: 'file_exists', path: 'src/cart.js' } }])] }, ctx);
    const ok2 = validatePlan({ summary: 'Build the cart module', tasks: [task([{ kind: 'rubric_review', statement: 'createCart handles quantities as specified', independence: 'different_lineage_model' }])] }, ctx);
    expect(ok1.errors).toEqual([]);
    expect(ok2.errors).toEqual([]);
  });
});

describe('a test suite that ran nothing is not evidence', async () => {
  const { ranNoTests } = await import('../src/verification/verifiers.js');
  it('recognizes zero-test runs across common runners, and not real ones', () => {
    expect(ranNoTests('TAP version 13\n1..0\n# tests 0\n# pass 0\n')).toBe(true);           // node --test with no test files
    expect(ranNoTests('No tests found, exiting with code 0')).toBe(true);                   // jest --passWithNoTests
    expect(ranNoTests('No test files found, exiting with code 0')).toBe(true);              // vitest --passWithNoTests
    expect(ranNoTests('\n  0 passing (2ms)\n')).toBe(true);                                 // mocha
    expect(ranNoTests('collected 0 items\n')).toBe(true);                                   // pytest
    expect(ranNoTests('?   	example.com/app	[no test files]\n')).toBe(true);                // go test
    expect(ranNoTests('TAP version 13\nok 1 - adds\n1..1\n# tests 1\n# pass 1\n')).toBe(false);
    expect(ranNoTests('\n  10 passing (5ms)\n')).toBe(false);
    expect(ranNoTests('Tests:       12 passed, 12 total')).toBe(false);
  });
});

describe('QA tests wait for the code they test', () => {
  const eng = byKey('engineering');
  const ctx = { department: eng, leadRoleKey: 'engineering_lead', requirementKeys: ['REQ-1', 'REQ-2'], budgetRemaining: 1, riskFloor: 'R1' as const, settings: { test_command: 'node --test' } };
  it('adds the missing dependency from a QA task to the build tasks for the same requirements', () => {
    const v = validatePlan({ summary: 'Build and test the cart', tasks: [
      { ref: 'a', title: 'Build totals', kind: 'implementation', spec: 'Implement totals', owner_role: 'software_engineer', requirement_keys: ['REQ-1'], budget_usd: 0.1 },
      { ref: 'b', title: 'Build discounts', kind: 'implementation', spec: 'Implement discounts', owner_role: 'software_engineer', requirement_keys: ['REQ-2'], budget_usd: 0.1 },
      { ref: 'qa', title: 'Acceptance tests', kind: 'implementation', spec: 'Write acceptance tests', owner_role: 'qa_engineer', requirement_keys: ['REQ-1', 'REQ-2'], budget_usd: 0.1 },
    ] }, ctx);
    expect(v.errors).toEqual([]);
    expect(v.tasks.find((t) => t.ref === 'qa')!.depends_on).toEqual(['a', 'b']);
    expect(v.warnings.join('\n')).toMatch(/\[qa\] tests will start after a, b/);
  });
});

describe('files a requirement names become platform-checked deliverables', async () => {
  const { namedPaths } = await import('../src/ledger/plan.js');
  it('finds named files, ignoring URLs, versions and prose', () => {
    expect(namedPaths('Create src/cart.js (ES module) exporting createCart(). Tests in test/cart.test.js.')).toEqual(['src/cart.js', 'test/cart.test.js']);
    expect(namedPaths('Write the spec in `design/SPEC.md` and update README.md.')).toEqual(['design/SPEC.md', 'README.md']);
    expect(namedPaths('See https://example.com/docs/a.html, use Node 22.5, e.g. totals, rounded to 0.1.')).toEqual([]);
  });
  it('adds a file_exists check to each build task covering the requirement', () => {
    const eng = byKey('engineering');
    const v = validatePlan({ summary: 'Build the cart module', tasks: [
      { ref: 'impl', title: 'Build the cart', kind: 'implementation', spec: 'Implement it', owner_role: 'software_engineer', requirement_keys: ['REQ-1'], budget_usd: 0.1 },
    ] }, { department: eng, leadRoleKey: 'engineering_lead', requirementKeys: ['REQ-1'], budgetRemaining: 1, riskFloor: 'R1', settings: { test_command: 'node --test' },
      requirementTexts: { 'REQ-1': 'Create src/cart.js exporting createCart(); tests in test/cart.test.js.' } });
    expect(v.errors).toEqual([]);
    const checks = v.tasks[0]!.criteria.filter((c) => c.check?.type === 'file_exists').map((c) => c.statement);
    expect(checks).toEqual(['src/cart.js exists (named in REQ-1)', 'test/cart.test.js exists (named in REQ-1)']);
  });
});

describe('plans from weaker models: forgiving on shape, strict on meaning', () => {
  const eng = byKey('engineering');
  const ctx = { department: eng, leadRoleKey: 'engineering_lead', requirementKeys: ['REQ-1'], budgetRemaining: 1, riskFloor: 'R1' as const, settings: { test_command: 'node --test' } };
  it('accepts {command}/{file} aliases and missing independence, and explains malformed checks', () => {
    const v = validatePlan({ summary: 'Build the cart module', tasks: [{ ref: 'a', title: 'Build cart', kind: 'implementation', spec: 'Implement the cart', owner_role: 'software_engineer',
      requirement_keys: ['REQ-1'], budget_usd: 0.1, criteria: [{ kind: 'deterministic', statement: 'tests pass', check: { type: 'command', command: 'node --test' } }, { kind: 'deterministic', statement: 'cart exists', check: { file: 'src/cart.js' } }, { kind: 'rubric_review', statement: 'Readable code' }] }] }, ctx);
    expect(v.errors).toEqual([]);
    const crit = v.tasks[0]!.criteria;
    expect(crit.find((c) => c.statement === 'tests pass')!.check).toEqual({ type: 'command', run: 'node --test', timeout_s: 600 });
    expect(crit.find((c) => c.statement === 'cart exists')!.check).toEqual({ type: 'file_exists', path: 'src/cart.js' });
    expect(crit.find((c) => c.statement === 'Readable code')!.independence).toBe('different_lineage_model');
    const bad = validatePlan({ summary: 'Build the cart module', tasks: [{ ref: 'a', title: 'Build cart', kind: 'implementation', spec: 'Implement the cart', owner_role: 'software_engineer',
      requirement_keys: ['REQ-1'], budget_usd: 0.1, criteria: [{ kind: 'deterministic', statement: 'tests pass', check: { type: 'command' } }] }] }, ctx);
    expect(bad.errors.join('\n')).toMatch(/check\.run: Required — a check is \{"type":"command","run":"node --test"\}/);
  });
});

describe('planners get realistic per-task costs for their team’s models', async () => {
  const { typicalTaskCostUsd } = await import('../src/runtime/context.js');
  it('estimates a task (with one retry) from the model’s prices', () => {
    expect(typicalTaskCostUsd({ input: 0.10, output: 0.40 })).toBe(0.032);   // gpt-4.1-nano
    expect(typicalTaskCostUsd({ input: 0.40, output: 1.60 })).toBe(0.128);   // gpt-4.1-mini
  });
});
