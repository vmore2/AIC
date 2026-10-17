// The docs are part of the product: every team example a CEO might copy from the README or the team guide
// must pass the same architecture rules as a real team, alongside the recommended catalog.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/org/catalog.js';
import { compileTeam } from '../src/org/teamSpec.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-docs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FENCE = /```yaml\n([\s\S]*?)```/g;
const examples = (file: string) => [...readFileSync(file, 'utf8').split('\r\n').join('\n').matchAll(FENCE)]
  .map((m) => m[1]!).filter((y) => /^team: /m.test(y)).map((y) => ({ file, yaml: y, spec: parseYaml(y) as { team: string } }));

describe('documentation examples', () => {
  const all = [...examples('README.md'), ...examples('docs/creating-teams.md')];

  it('the README and the team guide contain team examples', () => {
    expect(all.filter((e) => e.file === 'README.md').length).toBeGreaterThanOrEqual(1);
    expect(all.filter((e) => e.file !== 'README.md').length).toBeGreaterThanOrEqual(5);
  });

  it.each(all.map((e) => [`${e.file}: ${e.spec.team}`, e] as const))('%s compiles and passes every rule next to the recommended teams', (_name, e) => {
    const r = compileTeam(e.spec);
    expect(r.errors).toEqual([]);
    // Cross-team rules (unique role keys) are checked against the shipped catalog, as `aic teams check` does.
    const teams = mkdtempSync(path.join(dir, 'teams-'));
    writeFileSync(path.join(teams, `${e.spec.team}.yaml`), e.yaml);
    const entry = loadCatalog(teams).get(e.spec.team)!;
    expect(entry.source).toBe('custom');
    expect(entry.errors).toEqual([]);
  });

  it('a lead that works with code gets a platform-checked integration criterion', () => {
    const r = compileTeam({ team: 'code_crew', name: 'Code Crew', purpose: 'Ships small, tested changes to our services.',
      roles: [{ title: 'Crew Lead', lead: true, works_with: ['code'], does: 'Splits goals into small, testable tasks with owners.' },
        { title: 'Crew Engineer', works_with: ['code'], does: 'Implements one task at a time with tests for every criterion.' }] });
    expect(r.errors).toEqual([]);
    const lead = r.department!.roles.find((x) => x.key === 'crew_lead')!;
    expect(lead.task_kinds).toContain('integration');
    expect(lead.criteria_templates).toMatchObject([{ kind: 'test_suite', independence: 'platform', check: { type: 'command', run: '${test_command}' } }]);
  });
});
