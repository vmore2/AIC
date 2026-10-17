// The README quickstart, exactly as a CEO types it: a fresh company folder, the real `aic` launcher,
// the starter config, the offline scripted model. Guards the first-run experience against regressions.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const AIC = path.resolve('bin/aic.mjs');
const root = mkdtempSync(path.join(os.tmpdir(), 'aic-cli-'));
// A company folder as deep as a real one (OneDrive, Documents, project folders): ~170 characters. On Windows,
// git cannot read clones much beyond 245 characters, so this guards the workspace layout against regressions.
let dir = path.join(root, 'OneDrive - Example Organization', 'Documents', 'Company');
while (dir.length < 170) dir = path.join(dir, 'Our Projects');
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

// Async on purpose: a blocking spawn would starve the test worker's heartbeat during long runs.
function aic(args: string[], cwd = dir): Promise<{ code: number | null; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const k of ['AIC_SPEND_CAP_USD', 'AIC_DEBUG', 'DATABASE_URL']) delete env[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [AIC, ...args], { cwd, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
      resolve({ code, out: `${stdout}${stderr}`.replace(/\x1b\[[0-9;]*m/g, '') });
    });
  });
}
const id = (out: string, prefix: string) => {
  const m = out.match(new RegExp(`${prefix}_[0-9a-f]{32}`));
  if (!m) throw new Error(`no ${prefix} id in:\n${out}`);
  return m[0];
};

describe('aic CLI: the README quickstart on a fresh company folder', () => {
  it('runs from init to a released, audited objective', async () => {
    let r = await aic(['init', '--company', 'Acme Inc', '--ceo', 'Your Name']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Acme Inc is ready');
    expect(readFileSync(path.join(dir, 'aic.config.yaml'), 'utf8')).toContain('name: Acme Inc');

    r = await aic(['teams']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/engineering\s+Software Engineering/);
    expect((await aic(['teams', 'check'])).code).toBe(0);
    expect((await aic(['hire', 'engineering'])).out).toContain('Hired Software Engineering');

    r = await aic(['chat', 'engineering_lead', 'I want a slugify(text) helper for our URLs: lowercase words joined by single hyphens, punctuation removed, no leading or trailing hyphens.']);
    expect(r.code, r.out).toBe(0);
    r = await aic(['confirm', id(r.out, 'dir')]);
    expect(r.out).toContain('Applied');
    const objectiveId = id(r.out, 'obj');

    expect((await aic(['run'])).out).toContain('need you');
    r = await aic(['inbox']);
    const proposal = id(r.out, 'prp');
    expect((await aic(['proposal', proposal])).out).toContain('Requirement coverage');
    expect((await aic(['approve', proposal])).code).toBe(0);
    r = await aic(['run']);
    expect(r.code, r.out).toBe(0);

    r = await aic(['status']);
    expect(r.out).toMatch(/verified \S+\s+100%/);
    r = await aic(['release', objectiveId]);
    expect(r.out).toContain('Released to main');
    r = await aic(['audit']);
    expect(r.out).toContain('Ledger hash chain intact');
    r = await aic(['doctor']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Ready for evaluation');
  }, 600_000);

  it('scaffolds a custom team that passes the architecture rules', async () => {
    let r = await aic(['teams', 'new', 'growth_marketing', '--name', 'Growth Marketing']);
    expect(r.code, r.out).toBe(0);
    r = await aic(['teams', 'check', 'growth_marketing']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('0 error(s)');
    r = await aic(['teams', 'show', 'growth_marketing']);
    expect(r.out).toContain('Growth Marketing Reviewer');
  }, 120_000);

  it('explains setup mistakes in one readable message, without a stack trace or the secret', async () => {
    const empty = mkdtempSync(path.join(dir, 'empty-'));
    let r = await aic(['status'], empty);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Run `aic init`');
    expect(r.out).not.toMatch(/\n\s+at /);

    const leaky = mkdtempSync(path.join(dir, 'leaky-'));
    const token = 'github_pat_11ABCDEFG0123456789_notarealtokenvalue';
    writeFileSync(path.join(leaky, 'aic.config.yaml'), `company: { name: X }\nmodels: { profiles: [{ key: s, provider: scripted, model: s, family: s }], default: s }\ncode_hosting: { kind: github, repo: acme/app, token_env: ${token} }\n`);
    r = await aic(['status'], leaky);
    expect(r.code).toBe(1);
    expect(r.out).toContain('code_hosting.token_env');
    expect(r.out).toContain('looks like a secret value');
    expect(r.out).not.toContain(token);
  }, 120_000);
});
