// Deterministic verifiers (architecture.md §11.2). They run against a FRESH checkout of the exact
// submitted commit — never the producer's workspace — and record evidence as platform services.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { SYSTEM } from '../domain/types.js';
import type { Ledger } from '../ledger/ledger.js';
import { validatePlan } from '../ledger/plan.js';
import { getCriteria, getEmployee, getObjective, getTask } from '../ledger/store.js';
import type { Department } from '../org/schema.js';
import type { Workspaces } from '../execution/codeHost.js';
import type { SandboxPort } from '../execution/sandbox.js';

const PLACEHOLDER = /\b(TODO|TBD|FIXME|lorem ipsum|\[insert|XXX)\b/i;

export interface VerifierDeps { ledger: Ledger; workspaces: Workspaces; sandbox: SandboxPort }

export async function runDeterministicVerifiers(d: VerifierDeps, taskId: string): Promise<number> {
  const q = d.ledger.db;
  const task = await getTask(q, taskId);
  const sub = (await q.query<{ id: string; criteria_set_id: string }>(`SELECT id, criteria_set_id FROM submissions WHERE task_id = $1 AND status = 'open'`, [taskId])).rows[0];
  if (!sub) return 0;
  const criteria = await getCriteria(q, sub.criteria_set_id);
  const already = new Set((await q.query<{ criterion_id: string }>(`SELECT criterion_id FROM evidence WHERE submission_id = $1 AND verifier_type = 'service'`, [sub.id])).rows.map((r) => r.criterion_id));
  const art = (await q.query<{ external_ref: string | null }>(
    `SELECT av.external_ref FROM submission_artifacts sa JOIN artifact_versions av ON av.id = sa.artifact_version_id WHERE sa.submission_id = $1`, [sub.id])).rows[0];

  let recorded = 0;
  let checkout: string | null = null;
  const record = async (criterionId: string, service: string, independence: 'platform_deterministic' | 'sandboxed_runner', result: 'pass' | 'fail' | 'error', details: Record<string, unknown>) => {
    await d.ledger.run('recordEvidence', { submissionId: sub.id, criterionId, result, definitive: result !== 'error', details, service: { id: service, independence } },
      SYSTEM, `verify:${sub.id}:${criterionId}`);
    recorded++;
  };

  try {
    for (const c of criteria) {
      if (already.has(c.id)) continue;
      const check = c.check_spec as ({ type: string } & Record<string, unknown>) | null;
      if (c.kind === 'rubric_review' || c.kind === 'human_judgment' || c.independence === 'human' || c.independence === 'different_lineage_model') continue;
      if (!check) {
        await record(c.id, 'svc_unavailable', 'platform_deterministic', 'error', { reason: 'No verifier is installed for this criterion; a connector or human must supply evidence.' });
        continue;
      }
      if (check.type === 'plan_validation') {
        const p = (await q.query<{ content: unknown }>(`SELECT content FROM proposals WHERE task_id = $1 AND status = 'submitted' ORDER BY created_at DESC LIMIT 1`, [taskId])).rows[0];
        const obj = await getObjective(q, task.objective_id);
        const dept = (await q.query<{ template: Department }>('SELECT template FROM departments WHERE id = $1', [obj.department_id])).rows[0]!.template;
        const lead = await getEmployee(q, task.owner_employee_id!);
        const reqs = (await q.query<{ key: string }>(`SELECT key FROM requirements WHERE objective_id = $1 AND status = 'active'`, [obj.id])).rows.map((r) => r.key);
        const v = p ? validatePlan(p.content, { department: dept, leadRoleKey: lead.role_key, requirementKeys: reqs, budgetRemaining: Number.MAX_SAFE_INTEGER, riskFloor: obj.risk_floor, settings: obj.settings }) : null;
        await record(c.id, 'svc_plan_validator', 'platform_deterministic', v?.ok ? 'pass' : 'fail', { errors: v?.errors ?? ['no proposal'], coverage: v?.coverage ?? {} });
        continue;
      }
      const sha = art?.external_ref?.startsWith('git:') ? art.external_ref.slice(4) : null;
      if (!sha) { await record(c.id, 'svc_artifact', 'platform_deterministic', 'error', { reason: 'Submission has no git artifact' }); continue; }
      checkout ??= await d.workspaces.checkoutForVerification(sha, taskId);
      const file = (p: unknown) => path.join(checkout!, String(p));
      switch (check.type) {
        case 'command': {
          const r = await d.sandbox.exec(checkout, String(check['run']), Number(check['timeout_s'] ?? 600) * 1000);
          await record(c.id, 'svc_command_runner', 'sandboxed_runner', r.exitCode === 0 ? 'pass' : r.exitCode === null && !r.timedOut ? 'error' : 'fail',
            { command: check['run'], exit_code: r.exitCode, timed_out: r.timedOut, stdout_tail: r.stdout.slice(-4000), stderr_tail: r.stderr.slice(-4000), sandbox_isolated: d.sandbox.isolated, commit: sha });
          break;
        }
        case 'file_exists':
          await record(c.id, 'svc_file_checker', 'platform_deterministic', existsSync(file(check['path'])) ? 'pass' : 'fail', { path: check['path'], commit: sha });
          break;
        case 'markdown_sections': {
          const f = file(check['path']);
          const text = existsSync(f) ? readFileSync(f, 'utf8') : '';
          const headings = new Set([...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => m[1]!.trim().toLowerCase()));
          const missing = (check['sections'] as string[]).filter((s) => !headings.has(s.toLowerCase()));
          const empty = (check['sections'] as string[]).filter((s) => sectionBody(text, s).trim().length < 20);
          await record(c.id, 'svc_document_checker', 'platform_deterministic', text && !missing.length && !empty.length ? 'pass' : 'fail',
            { path: check['path'], missing_sections: missing, empty_sections: empty.filter((s) => !missing.includes(s)), file_found: !!text, commit: sha });
          break;
        }
        case 'no_placeholder_text': {
          const f = file(check['path']);
          const text = existsSync(f) ? readFileSync(f, 'utf8') : null;
          const hit = text?.match(PLACEHOLDER)?.[0];
          await record(c.id, 'svc_document_checker', 'platform_deterministic', text !== null && !hit ? 'pass' : 'fail', { path: check['path'], file_found: text !== null, placeholder: hit ?? null, commit: sha });
          break;
        }
        default:
          await record(c.id, 'svc_unavailable', 'platform_deterministic', 'error', { reason: `Unknown check type ${check.type}` });
      }
    }
  } finally {
    if (checkout) rmSync(checkout, { recursive: true, force: true, maxRetries: 3 });
  }
  return recorded;
}

function sectionBody(text: string, heading: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, '').trim().toLowerCase() === heading.toLowerCase());
  if (start < 0) return '';
  const level = lines[start]!.match(/^#+/)![0].length;
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^(#+)\s+/);
    if (m && m[1]!.length <= level) break;
    body.push(l);
  }
  return body.join('\n');
}
