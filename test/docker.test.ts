import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { ConfigSchema } from '../src/config/config.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';
import { defaultSandboxUser, DockerSandbox } from '../src/execution/sandbox.js';
import { runDoctor } from '../src/ops/doctor.js';
import { dept } from './helpers.js';

const dockerUp = (() => { try { execFileSync('docker', ['image', 'inspect', 'node:22-bookworm-slim'], { stdio: 'ignore', timeout: 15_000 }); return true; } catch { return false; } })();
const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-docker-'));
let app: App | undefined;
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

describe.skipIf(!dockerUp)('Docker sandbox, live (requires Docker + node:22-bookworm-slim)', () => {
  const sb = new DockerSandbox({ image: 'node:22-bookworm-slim', memory: '512m', cpus: 1, pids: 128, network: 'none' });

  it('confines agent commands: non-root, read-only root, no capabilities, only the workspace is writable, secrets absent', async () => {
    const ws = mkdtempSync(path.join(dir, 'ws-'));
    writeFileSync(path.join(ws, 'input.txt'), 'hello');
    process.env['AIC_FAKE_SECRET'] = 'sk-should-not-leak';
    const r = await sb.exec(ws, [
      'echo "uid=$(id -u)"',
      'touch /etc/pwned 2>/dev/null && echo ROOTFS-WRITABLE || echo ROOTFS-READONLY',
      'cat input.txt && echo ok > output.txt && echo WORKSPACE-WRITABLE',
      'grep -q CapEff:.0000000000000000 /proc/self/status && echo NO-CAPS || echo HAS-CAPS',
      'env | grep -c AIC_FAKE_SECRET || true',
      'ls /host 2>/dev/null || echo NO-HOST-MOUNT',
    ].join('; '), 120_000);
    delete process.env['AIC_FAKE_SECRET'];
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`uid=${defaultSandboxUser().split(':')[0]}`);
    expect(r.stdout).not.toContain('uid=0');
    expect(r.stdout).toContain('ROOTFS-READONLY');
    expect(r.stdout).toContain('hello');
    expect(r.stdout).toContain('WORKSPACE-WRITABLE');
    expect(r.stdout).toContain('NO-CAPS');
    expect(r.stdout).toMatch(/^0$/m); // the host's secret env var is not visible
    expect(r.stdout).toContain('NO-HOST-MOUNT');
  }, 180_000);

  it('enforces resource limits and the timeout', async () => {
    const ws = mkdtempSync(path.join(dir, 'ws-'));
    const t0 = Date.now();
    const r = await sb.exec(ws, 'sleep 60', 3_000);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(30_000);
    // A fork bomb hits the PID limit (128) instead of exhausting the host.
    const fork = await sb.exec(ws, 'n=0; for i in $(seq 1 400); do sleep 5 & n=$((n+1)); done; echo spawned=$n', 60_000);
    expect(fork.stdout + fork.stderr).toMatch(/Resource temporarily unavailable|Cannot fork|can't fork/i);
  }, 120_000);

  it('runs a full objective with every test and verification inside containers', async () => {
    app = await createApp(ConfigSchema.parse({
      company: { name: 'Docker Co' }, database: { local_path: path.join(dir, 'db') },
      models: { profiles: [{ key: 'scripted', provider: 'scripted', model: 's', family: 'a' }, { key: 'rev', provider: 'scripted', model: 's', family: 'b' }],
        default: 'scripted', assignments: { code_reviewer: 'rev' } },
      code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'), teams_path: path.join(dir, 'teams'),
      sandbox: { kind: 'docker', docker: { image: 'node:22-bookworm-slim', memory: '1g', cpus: 1, network: 'none' } },
    }));
    const doctor = await runDoctor(app);
    expect(doctor.find((d) => d.check === 'Sandbox')).toMatchObject({ level: 'pass' });
    const b = await app.ledger.run('bootstrapCompany', { companyName: 'Docker Co', ceoName: 'C', defaultMode: 'M4', projectSettings: { test_command: 'node --test' } }, SYSTEM);
    const ceo: Principal = { type: 'user', id: b.ceoUserId, stepUp: true };
    const eng = dept('engineering');
    await app.ledger.run('hireDepartment', { template: eng, models: Object.fromEntries(eng.roles.map((r) => [r.key, app!.config.models.profiles[r.category === 'reviewer' ? 1 : 0]!])) }, ceo);
    const obj = await app.ledger.run('createObjective', { title: 'Slugs', departmentKey: 'engineering', budgetUsd: 100,
      requirements: [{ key: 'REQ-1', text: 'Provide slugify(text): lowercase words joined by single hyphens, punctuation removed, no leading or trailing hyphens.' }] }, ceo);
    await app.orchestrator.runUntilIdle(120_000);
    const prop = (await app.ledger.db.query<{ id: string }>('SELECT id FROM proposals WHERE task_id = $1', [obj.planningTaskId])).rows[0]!;
    await app.ledger.run('decideProposal', { proposalId: prop.id, decision: 'approve' }, ceo);
    await app.orchestrator.runUntilIdle(300_000);

    const tasks = (await app.ledger.db.query<{ id: string; title: string; status: string; attempt: number }>(`SELECT id, title, status, attempt FROM tasks WHERE parent_task_id = $1`, [obj.planningTaskId])).rows;
    expect(tasks.map((t) => t.status)).toEqual(['accepted', 'accepted']);
    const impl = tasks.find((t) => t.title.startsWith('Deliver'))!;
    expect(impl.attempt).toBe(2); // the buggy first attempt was caught by tests running in a container
    const ev = (await app.ledger.db.query<{ result: string; details: { sandbox_isolated: boolean } }>(
      `SELECT result, details FROM evidence WHERE task_id = $1 AND verifier_id = 'svc_command_runner' ORDER BY created_at`, [impl.id])).rows;
    expect(ev.map((e) => e.result)).toEqual(['fail', 'pass']);
    expect(ev.every((e) => e.details.sandbox_isolated === true)).toBe(true);
    const o = (await app.ledger.db.query<{ status: string }>('SELECT status FROM objectives WHERE id = $1', [obj.objectiveId])).rows[0]!;
    expect(o.status).toBe('completed');
  }, 600_000);
});
