// Tool Gateway — the only path from an agent to any effect (architecture.md §6.8, INV-5).
// Every call: verify credential → check lease epoch against the ledger → validate arguments →
// check grants → PDP decision → audit record → execute → return tainted, labeled output.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { hashOf } from '../domain/hash.js';
import { newId } from '../domain/ids.js';
import { effectiveMode, gateFor } from '../domain/modes.js';
import { SYSTEM, type Principal } from '../domain/types.js';
import { DomainError } from '../ledger/engine.js';
import type { Ledger } from '../ledger/ledger.js';
import { getEmployee, getLease, getRun, getTask, modesFor } from '../ledger/store.js';
import { TOOLS_BY_NAME, type Taint } from '../org/toolCatalog.js';
import { CriterionTemplateSchema } from '../org/schema.js';
import type { Workspaces, Workspace } from '../execution/codeHost.js';
import type { SandboxPort } from '../execution/sandbox.js';
import type { CredentialIssuer, RunClaims } from './credentials.js';
import { buildTaskContract } from './context.js';
import type { ToolSpec } from './modelPort.js';

export interface ToolResult { ok: boolean; content: string; taint: Taint; terminal?: 'submitted' | 'suspended' | 'review_recorded' }

interface RunEnv { claims: RunClaims; principal: Principal; workspace: Workspace | null }
interface BuiltinTool {
  schema: z.ZodTypeAny;
  description?: string;
  run(env: RunEnv, args: never, gw: ToolGateway): Promise<ToolResult>;
}

const ok = (content: unknown, taint: Taint = 'trusted', terminal?: ToolResult['terminal']): ToolResult =>
  ({ ok: true, content: typeof content === 'string' ? content : JSON.stringify(content, null, 2), taint, ...(terminal ? { terminal } : {}) });
const fail = (msg: string): ToolResult => ({ ok: false, content: msg, taint: 'trusted' });

function safePath(ws: Workspace | null, p: string): string {
  if (!ws) throw new DomainError('validation', 'This run has no workspace');
  const full = path.resolve(ws.dir, p);
  const rel = path.relative(ws.dir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new DomainError('validation', 'Path escapes the workspace');
  if (rel.split(path.sep)[0] === '.git') throw new DomainError('validation', 'The .git directory is managed by the platform');
  // Resolve symlinks on the deepest existing ancestor so links created inside the workspace cannot escape it.
  let probe = full;
  while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const realRel = path.relative(realpathSync(ws.dir), realpathSync(probe));
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new DomainError('validation', 'Path escapes the workspace via a link');
  return full;
}

const STATE_ASSERTION = /\b(approved|is done|is complete(d)?|accepted|have permission|authorized to|CEO said)\b/i;

const BUILTINS: Record<string, BuiltinTool> = {
  'ledger.get_task_contract': {
    schema: z.object({}).passthrough(),
    run: async (env, _a, gw) => {
      if (!env.claims.taskId) return fail('No task attached to this run');
      return ok(await buildTaskContract(gw.ledger.db, env.claims.taskId, env.claims.employeeId));
    },
  },
  'ledger.get_team_board': {
    schema: z.object({}).passthrough(),
    run: async (env, _a, gw) => {
      const rows = await gw.ledger.db.query(
        `SELECT t.id, t.title, t.kind, t.status, t.hold, t.integrity, t.attempt, e.display_name AS owner
         FROM tasks t LEFT JOIN employees e ON e.id = t.owner_employee_id WHERE t.manager_employee_id = $1 ORDER BY t.created_at`, [env.claims.employeeId]);
      return ok({ note: 'Authoritative ledger state of tasks you manage.', tasks: rows.rows });
    },
  },
  'ledger.propose_plan': {
    // Lenient on shape (models often put fields beside `plan`); strict on content (validatePlan).
    schema: z.object({ plan: z.record(z.unknown()).default({}) }).passthrough(),
    run: async (env, a: { plan: Record<string, unknown> } & Record<string, unknown>, gw) => {
      const { plan, ...rest } = a;
      const merged = { ...rest, ...plan } as Record<string, unknown>;
      delete merged['requirement_keys'];
      try {
        const r = await gw.ledger.run('proposePlan', { taskId: env.claims.taskId!, plan: merged }, env.principal);
        return ok({ status: 'submitted', proposal_id: r.proposalId, warnings: r.validation.warnings,
          message: 'Plan submitted. The platform validates it independently and the CEO decides. Your run will now end.' }, 'trusted', 'submitted');
      } catch (e) {
        if (e instanceof DomainError && e.code === 'validation') return fail(`Plan rejected by validation. Fix these and call ledger.propose_plan again:\n- ${((e.details['errors'] as string[]) ?? [e.message]).join('\n- ')}`);
        throw e;
      }
    },
  },
  'ledger.submit_work': {
    schema: z.object({
      summary: z.string().min(3),
      per_criterion: z.array(z.object({ criterion_id: z.string(), self_assessment: z.enum(['met', 'partially_met', 'not_met']), notes: z.string().optional() })).optional(),
      known_gaps: z.array(z.string()).optional(),
    }),
    run: async (env, a: { summary: string; per_criterion?: never[]; known_gaps?: string[] }, gw) => {
      if (!env.workspace) return fail('No workspace to submit');
      const emp = await getEmployee(gw.ledger.db, env.claims.employeeId);
      const pushed = await gw.pushWorkspace(env, `${emp.display_name}: ${a.summary}`.slice(0, 200));
      if (!pushed.ok) return fail(pushed.error);
      // Verify the commit is really on this run's branch before recording it as an artifact (RT-53).
      if (!(await gw.workspaces.commitExistsOnBranch(pushed.sha, env.workspace.branch))) return fail('Submitted commit is not on your run branch');
      const r = await gw.ledger.run('submitWork', {
        taskId: env.claims.taskId!,
        artifacts: [{ kind: 'git_commit', name: env.workspace.branch, contentSha256: pushed.tree, externalRef: `git:${pushed.sha}` }],
        claim: { summary: a.summary, per_criterion: a.per_criterion ?? [], known_gaps: a.known_gaps ?? [] },
      }, env.principal);
      return ok({ status: 'submitted', submission_id: r.submissionId, commit: pushed.sha,
        message: 'Submission recorded. Independent verification decides acceptance; you cannot mark the task complete. Your run will now end.' }, 'trusted', 'submitted');
    },
  },
  'ledger.raise_blocker': {
    schema: z.object({ type: z.enum(['blocker', 'decision_required']).default('blocker'), question: z.string().min(5),
      options: z.array(z.object({ id: z.string(), summary: z.string(), consequences: z.string().optional() })).optional(), recommendation: z.string().optional() }),
    run: async (env, a: { type: 'blocker' | 'decision_required'; question: string; options?: never[]; recommendation?: string }, gw) => {
      const r = await gw.ledger.run('raiseEscalation', { taskId: env.claims.taskId!, type: a.type, question: a.question, options: a.options, recommendation: a.recommendation, blocking: true }, env.principal);
      return ok({ escalation_id: r.escalationId, message: 'Escalated. Your run is suspended until it is resolved.' }, 'trusted', 'suspended');
    },
  },
  'ledger.ask_question': {
    schema: z.object({ question: z.string().min(5), blocking: z.boolean().default(false) }),
    run: async (env, a: { question: string; blocking: boolean }, gw) => {
      const r = await gw.ledger.run('raiseEscalation', { taskId: env.claims.taskId!, type: 'question', question: a.question, blocking: a.blocking }, env.principal);
      return ok({ escalation_id: r.escalationId, blocking: a.blocking }, 'trusted', a.blocking ? 'suspended' : undefined);
    },
  },
  'ledger.post_update': {
    schema: z.object({ text: z.string().min(1).max(2000) }),
    run: async (env, a: { text: string }, gw) => { await gw.ledger.run('postUpdate', { taskId: env.claims.taskId!, text: a.text }, env.principal); return ok('Posted (shown as a claim, not as status).'); },
  },
  'ledger.propose_directive': {
    schema: z.object({ type: z.enum(['create_objective', 'decision', 'change_requirement']), summary: z.string().min(5), payload: z.record(z.unknown()) }),
    run: async (env, a: { type: 'create_objective' | 'decision' | 'change_requirement'; summary: string; payload: Record<string, unknown> }, gw) => {
      try {
        const r = await gw.ledger.run('proposeDirective', { type: a.type, summary: a.summary, payload: a.payload }, env.principal);
        return ok({ directive_id: r.directiveId, status: 'pending_confirmation', message: 'Proposal recorded. Nothing changes until the CEO confirms it.' });
      } catch (e) {
        if (e instanceof DomainError && e.code === 'validation') return fail(e.message);
        throw e;
      }
    },
  },
  'review.record_verdict': {
    schema: z.object({ verdicts: z.array(z.object({
      criterion_id: z.string(), verdict: z.enum(['pass', 'fail', 'inconclusive']), confidence: z.number().min(0).max(1).optional(),
      findings: z.array(z.object({ location: z.string().min(1), description: z.string().min(3), severity: z.enum(['minor', 'major', 'critical']).optional() })).default([]),
    })).min(1) }),
    run: async (env, a: { verdicts: { criterion_id: string; verdict: 'pass' | 'fail' | 'inconclusive'; confidence?: number; findings: { location: string; description: string }[] }[] }, gw) => {
      const run = await getRun(gw.ledger.db, env.claims.runId);
      for (const v of a.verdicts) {
        // Failing verdicts without located findings are downgraded to inconclusive (§11.3).
        const result = v.verdict === 'fail' && v.findings.length === 0 ? 'inconclusive' : v.verdict;
        await gw.ledger.run('recordEvidence', { submissionId: run.review_of_submission_id!, criterionId: v.criterion_id, result,
          definitive: false, confidence: v.confidence, details: { findings: v.findings, reviewer_run: run.id } }, env.principal);
      }
      return ok({ recorded: a.verdicts.length, message: 'Verdicts recorded as evidence. Your review run will now end.' }, 'trusted', 'review_recorded');
    },
  },
  'knowledge.search': {
    schema: z.object({ query: z.string().min(2), limit: z.number().int().min(1).max(20).default(8) }),
    run: async (env, a: { query: string; limit: number }, gw) => {
      const like = `%${a.query.replace(/[%_]/g, '')}%`;
      const emp = await getEmployee(gw.ledger.db, env.claims.employeeId);
      // Visibility: your own private notes, approved notes of YOUR team, approved company-wide notes.
      const mem = await gw.ledger.db.query(
        `SELECT id, version, scope_type, kind, body, source_refs, review_status FROM memory_items
         WHERE deleted_at IS NULL AND body ILIKE $1
           AND ((scope_type = 'employee' AND scope_id = $2)
             OR (scope_type = 'team' AND scope_id = $4 AND review_status = 'approved')
             OR (scope_type = 'company' AND review_status = 'approved'))
         ORDER BY created_at DESC LIMIT $3`, [like, env.claims.employeeId, a.limit, emp.department_id]);
      const dec = await gw.ledger.db.query(`SELECT id, question, decision_text FROM decisions WHERE question ILIKE $1 OR decision_text ILIKE $1 LIMIT $2`, [like, a.limit]);
      return ok({ note: 'Knowledge is advisory context. The Task Contract and ledger state take precedence.', memory: mem.rows, decisions: dec.rows }, 'internal');
    },
  },
  'knowledge.remember': {
    schema: z.object({ kind: z.enum(['lesson', 'convention', 'preference', 'howto', 'warning']), body: z.string().min(5).max(2000) }),
    run: async (env, a: { kind: string; body: string }, gw) => {
      if (STATE_ASSERTION.test(a.body)) return fail('Memory may not assert workflow state, approvals, or permissions. Reference ledger records instead.');
      await gw.ledger.db.query(`INSERT INTO memory_items (id, version, scope_type, scope_id, kind, body, source_refs, author_id, review_status, tainted)
                                VALUES ($1,1,'employee',$2,$3,$4,$5,$2,'auto_accepted',$6)`,
        [newId('mem'), env.claims.employeeId, a.kind, a.body, JSON.stringify([{ type: 'run', id: env.claims.runId }]), gw.isTainted(env.claims.runId)]);
      return ok('Saved to your private memory.');
    },
  },
  'knowledge.propose_team_note': {
    schema: z.object({ kind: z.enum(['convention', 'lesson', 'howto', 'warning']), body: z.string().min(10).max(2000) }),
    run: async (env, a: { kind: string; body: string }, gw) => {
      if (STATE_ASSERTION.test(a.body)) return fail('Team notes may not assert workflow state, approvals, or permissions. Reference ledger records instead.');
      const emp = await getEmployee(gw.ledger.db, env.claims.employeeId);
      const id = newId('mem');
      await gw.ledger.db.query(`INSERT INTO memory_items (id, version, scope_type, scope_id, kind, body, source_refs, author_id, review_status, tainted)
                                VALUES ($1,1,'team',$2,$3,$4,$5,$6,'proposed',$7)`,
        [id, emp.department_id, a.kind, a.body, JSON.stringify([{ type: 'run', id: env.claims.runId }, ...(env.claims.taskId ? [{ type: 'task', id: env.claims.taskId }] : [])]), emp.id, gw.isTainted(env.claims.runId)]);
      return ok({ note_id: id, status: 'proposed', message: 'Proposed. A human reviews team notes before teammates see them.' });
    },
  },
  'fs.read': {
    schema: z.object({ path: z.string().min(1) }),
    run: async (env, a: { path: string }) => {
      const f = safePath(env.workspace, a.path);
      if (!existsSync(f) || statSync(f).isDirectory()) return fail(`No such file: ${a.path}`);
      return ok(readFileSync(f, 'utf8').slice(0, 100_000), 'internal');
    },
  },
  'fs.write': {
    schema: z.object({ path: z.string().min(1), content: z.string().max(500_000) }),
    run: async (env, a: { path: string; content: string }) => {
      const f = safePath(env.workspace, a.path);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, a.content);
      return ok(`Wrote ${a.path} (${a.content.length} bytes)`);
    },
  },
  'fs.list': {
    schema: z.object({ path: z.string().default('.') }),
    run: async (env, a: { path: string }) => {
      const root = safePath(env.workspace, a.path);
      if (!existsSync(root)) return fail(`No such directory: ${a.path}`);
      const out: string[] = [];
      const walk = (d: string, depth: number) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.name === '.git' || e.name === 'node_modules') continue;
          const p = path.join(d, e.name);
          out.push(path.relative(env.workspace!.dir, p).replace(/\\/g, '/') + (e.isDirectory() ? '/' : ''));
          if (e.isDirectory() && depth < 4 && out.length < 500) walk(p, depth + 1);
        }
      };
      walk(root, 0);
      return ok(out.join('\n'), 'internal');
    },
  },
  'sandbox.exec': {
    schema: z.object({ command: z.string().min(1).max(2000), timeout_s: z.number().int().min(1).max(900).default(120) }),
    run: async (env, a: { command: string; timeout_s: number }, gw) => {
      if (!env.workspace) return fail('No workspace');
      const r = await gw.sandbox.exec(env.workspace.dir, a.command, a.timeout_s * 1000);
      return ok({ exit_code: r.exitCode, timed_out: r.timedOut, stdout: r.stdout.slice(-20_000), stderr: r.stderr.slice(-10_000),
        isolated: gw.sandbox.isolated }, 'internal');
    },
  },
  'repo.commit_and_push': {
    schema: z.object({ message: z.string().min(3).max(200) }),
    run: async (env, a: { message: string }, gw) => {
      const r = await gw.pushWorkspace(env, a.message);
      return r.ok ? ok({ commit: r.sha, branch: env.workspace!.branch }) : fail(r.error);
    },
  },
  'email.draft': {
    schema: z.object({ to: z.array(z.string()).min(1), subject: z.string(), body: z.string() }),
    run: async (env, a: { to: string[]; subject: string; body: string }) => {
      const f = safePath(env.workspace, `drafts/${Date.now()}-${a.subject.replace(/[^\w-]+/g, '-').slice(0, 40)}.md`);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, `To: ${a.to.join(', ')}\nSubject: ${a.subject}\n\n${a.body}\n`);
      return ok(`Draft saved (not sent): ${path.relative(env.workspace!.dir, f)}`);
    },
  },
};

/** JSON-Schema-ish parameter descriptions given to models (zod remains the authority). */
const PARAMS: Record<string, Record<string, unknown>> = {
  'ledger.propose_plan': { type: 'object', required: ['plan'], properties: { plan: {
    type: 'object', required: ['summary', 'tasks'], description: 'The whole plan. The tasks array goes INSIDE plan.',
    properties: {
      summary: { type: 'string' },
      tasks: { type: 'array', minItems: 1, items: { type: 'object', required: ['ref', 'title', 'kind', 'spec', 'owner_role', 'requirement_keys', 'budget_usd'], properties: {
        ref: { type: 'string', description: 'short id, e.g. t1' }, title: { type: 'string' },
        kind: { type: 'string', enum: ['discovery', 'implementation', 'integration', 'research', 'decision', 'remediation', 'operation'] },
        spec: { type: 'string', description: 'exactly what to deliver' }, owner_role: { type: 'string', description: 'a role key from your_team' },
        requirement_keys: { type: 'array', items: { type: 'string' } }, depends_on: { type: 'array', items: { type: 'string' } },
        budget_usd: { type: 'number', description: 'the sum over all tasks must fit budget_available_usd' },
        criteria: { type: 'array', description: 'optional extra acceptance criteria; role defaults are added automatically', items: { type: 'object' } },
      } } },
      risks: { type: 'array', items: { type: 'string' } },
      open_questions: { type: 'array', items: { type: 'string' } },
    } } } },
  'ledger.submit_work': { type: 'object', properties: { summary: { type: 'string' }, per_criterion: { type: 'array', items: { type: 'object', properties: { criterion_id: { type: 'string' }, self_assessment: { type: 'string', enum: ['met', 'partially_met', 'not_met'] }, notes: { type: 'string' } } } }, known_gaps: { type: 'array', items: { type: 'string' } } }, required: ['summary'] },
  'ledger.raise_blocker': { type: 'object', properties: { type: { type: 'string', enum: ['blocker', 'decision_required'] }, question: { type: 'string' }, options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, summary: { type: 'string' }, consequences: { type: 'string' } } } }, recommendation: { type: 'string' } }, required: ['question'] },
  'ledger.ask_question': { type: 'object', properties: { question: { type: 'string' }, blocking: { type: 'boolean' } }, required: ['question'] },
  'ledger.post_update': { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  'ledger.propose_directive': { type: 'object', properties: { type: { type: 'string', enum: ['create_objective', 'decision', 'change_requirement'] }, summary: { type: 'string' }, payload: { type: 'object', description: 'create_objective: {title, requirements:[{key:"REQ-1",text}], budget_usd}; decision: {question, decision, objective_id}; change_requirement: {objective_id, key:"REQ-2", text, reason}' } }, required: ['type', 'summary', 'payload'] },
  'review.record_verdict': { type: 'object', properties: { verdicts: { type: 'array', items: { type: 'object', properties: { criterion_id: { type: 'string' }, verdict: { type: 'string', enum: ['pass', 'fail', 'inconclusive'] }, confidence: { type: 'number' }, findings: { type: 'array', items: { type: 'object', properties: { location: { type: 'string' }, description: { type: 'string' }, severity: { type: 'string' } }, required: ['location', 'description'] } } }, required: ['criterion_id', 'verdict'] } } }, required: ['verdicts'] },
  'knowledge.search': { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
  'knowledge.remember': { type: 'object', properties: { kind: { type: 'string', enum: ['lesson', 'convention', 'preference', 'howto', 'warning'] }, body: { type: 'string' } }, required: ['kind', 'body'] },
  'knowledge.propose_team_note': { type: 'object', properties: { kind: { type: 'string', enum: ['convention', 'lesson', 'howto', 'warning'] }, body: { type: 'string' } }, required: ['kind', 'body'] },
  'fs.read': { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  'fs.write': { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  'fs.list': { type: 'object', properties: { path: { type: 'string' } } },
  'sandbox.exec': { type: 'object', properties: { command: { type: 'string' }, timeout_s: { type: 'integer' } }, required: ['command'] },
  'repo.commit_and_push': { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  'email.draft': { type: 'object', properties: { to: { type: 'array', items: { type: 'string' } }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] },
  'ledger.get_task_contract': { type: 'object', properties: {} },
  'ledger.get_team_board': { type: 'object', properties: {} },
};
void CriterionTemplateSchema;

/** Tool names are sanitized for providers that disallow dots. */
export const toProviderName = (n: string) => n.replace(/\./g, '__');
export const fromProviderName = (n: string) => n.replace(/__/g, '.');

export class ToolGateway {
  private readonly workspacesByRun = new Map<string, Workspace>();
  private readonly tainted = new Set<string>();

  constructor(readonly ledger: Ledger, readonly issuer: CredentialIssuer, readonly workspaces: Workspaces, readonly sandbox: SandboxPort) {}

  attachWorkspace(runId: string, ws: Workspace) { this.workspacesByRun.set(runId, ws); }
  isTainted(runId: string) { return this.tainted.has(runId); }

  /** Tools offered to a run: role grants ∩ task grants, restricted to tools this installation implements. */
  async toolSpecs(claims: RunClaims): Promise<ToolSpec[]> {
    const names = await this.grantedTools(claims);
    return names.filter((n) => BUILTINS[n] && PARAMS[n]).map((n) => ({
      name: toProviderName(n), description: TOOLS_BY_NAME.get(n)!.description, parameters: PARAMS[n]!,
    }));
  }

  private async grantedTools(claims: RunClaims): Promise<string[]> {
    const emp = await getEmployee(this.ledger.db, claims.employeeId);
    if (claims.mode === 'review') return emp.tool_grants.filter((t) => ['review.record_verdict', 'fs.read', 'fs.list', 'knowledge.search', 'ledger.get_task_contract'].includes(t));
    if (claims.mode === 'conversation') return emp.tool_grants.filter((t) => ['ledger.get_team_board', 'knowledge.search', 'ledger.propose_directive'].includes(t));
    const task = await getTask(this.ledger.db, claims.taskId!);
    const taskGrants = new Set(task.tool_grants);
    const tools = emp.tool_grants.filter((t) => taskGrants.has(t));
    // Planning runs deliver a plan, not a commit.
    return task.kind === 'planning' ? tools.filter((t) => t !== 'ledger.submit_work') : tools.filter((t) => t !== 'ledger.propose_plan');
  }

  async invoke(token: string, call: { name: string; arguments: Record<string, unknown> }): Promise<ToolResult> {
    let claims: RunClaims;
    try { claims = this.issuer.verify(token); } catch (e) { return fail(`Unauthorized: ${(e as Error).message}`); }
    const name = fromProviderName(call.name);
    const def = TOOLS_BY_NAME.get(name);
    const principal: Principal = { type: 'employee', id: claims.employeeId, runId: claims.runId, epoch: claims.epoch };
    const audit = (decision: 'allow' | 'deny' | 'error', reasons: string[]) => this.ledger.run('recordToolCall',
      { runId: claims.runId, tool: name, actionClass: def?.actionClass ?? 'A0', argsSha256: hashOf(call.arguments), decision, reasons, epoch: claims.epoch }, SYSTEM).catch(() => undefined);

    if (!def) { await audit('deny', ['unknown_tool']); return fail(`Unknown tool "${name}"`); }
    const impl = BUILTINS[name];
    if (!impl) { await audit('deny', ['connector_not_installed']); return fail(`Tool "${name}" needs a connector that is not installed in this company.`); }

    // Fencing: the run must be live and hold the current lease epoch (INV-7).
    const run = await getRun(this.ledger.db, claims.runId);
    if (run.status !== 'running') { await audit('deny', [`run_${run.status}`]); return fail(`This run is ${run.status}; no further actions are allowed.`); }
    let mode = effectiveMode('M1');
    let riskTier: 'R0' | 'R1' | 'R2' | 'R3' = 'R1';
    let held = false;
    let epochCurrent = true;
    if (claims.taskId && claims.mode === 'task') {
      const lease = await getLease(this.ledger.db, claims.taskId);
      epochCurrent = !!lease && lease.epoch === claims.epoch && lease.state === 'active';
      const task = await getTask(this.ledger.db, claims.taskId);
      mode = effectiveMode(...(await modesFor(this.ledger.db, task.objective_id)));
      riskTier = task.risk_tier; held = task.hold !== null;
    } else if (claims.taskId) {
      const task = await getTask(this.ledger.db, claims.taskId);
      mode = effectiveMode(...(await modesFor(this.ledger.db, task.objective_id)));
    }

    const parsed = impl.schema.safeParse(call.arguments ?? {});
    if (!parsed.success) { await audit('error', ['invalid_arguments']); return fail(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`); }

    const granted = (await this.grantedTools(claims)).includes(name);
    const decision = this.ledger.engine.pdp.authorize({
      principal, attrs: { role: 'employee', can_manage: false, step_up: false }, action: 'tool.invoke', resource: { type: 'Tool', id: name },
      context: {
        mode, action_class: def.actionClass, gate: gateFor({ mode, actionClass: def.actionClass, riskTier }),
        is_owner: claims.mode === 'task', epoch_current: epochCurrent, stale_epoch: !epochCurrent, tool_granted: granted,
        task_held: held, is_assigned_reviewer: claims.mode === 'review', in_conversation: claims.mode === 'conversation',
      },
    });
    if (!decision.allowed) {
      const reasons = [!granted ? 'not_granted' : '', !epochCurrent ? 'stale_lease' : '', held ? 'task_held' : '', `mode_${mode}`].filter(Boolean);
      await audit('deny', reasons);
      return fail(`Denied by policy (${reasons.join(', ') || 'policy'}). You cannot perform "${name}" in this context.`);
    }
    await audit('allow', decision.reasons);
    if (def.outputTaint === 'untrusted') this.tainted.add(claims.runId);
    try {
      return await impl.run({ claims, principal, workspace: this.workspacesByRun.get(claims.runId) ?? null }, parsed.data as never, this);
    } catch (e) {
      if (e instanceof DomainError) return fail(`${e.code}: ${e.message}`);
      return fail(`Tool error: ${(e as Error).message}`);
    }
  }

  /** Commit + push as an external action with intent/outcome records (natural key: branch + commit). */
  async pushWorkspace(env: RunEnv, message: string): Promise<{ ok: true; sha: string; tree: string } | { ok: false; error: string }> {
    if (!env.workspace || !env.claims.taskId) return { ok: false, error: 'No workspace' };
    const emp = await getEmployee(this.ledger.db, env.claims.employeeId);
    const intent = await this.ledger.run('recordActionIntent', {
      taskId: env.claims.taskId, runId: env.claims.runId, epoch: env.claims.epoch, connector: 'git', action: 'push_branch', actionClass: 'A4',
      idempotencyMode: 'natural_key', naturalKey: env.workspace.branch, payload: { branch: env.workspace.branch, message },
    }, SYSTEM);
    await this.ledger.run('recordActionOutcome', { actionId: intent.actionId, status: 'attempting' }, SYSTEM);
    try {
      const r = await this.workspaces.commitAndPush(env.workspace, message, { name: emp.display_name, email: `${emp.id}@employees.aic.local` });
      await this.ledger.run('recordActionOutcome', { actionId: intent.actionId, status: 'succeeded', externalRef: `git:${r.sha}` }, SYSTEM);
      return { ok: true, sha: r.sha, tree: r.tree };
    } catch (e) {
      // Did the push land despite the error? Reconcile by natural key before deciding (§7.9).
      const remote = await this.workspaces.remoteSha(`refs/heads/${env.workspace.branch}`);
      const { git } = await import('../execution/codeHost.js');
      const local = await git(env.workspace.dir, ['rev-parse', 'HEAD']).catch(() => null);
      if (remote && local && remote === local) {
        await this.ledger.run('recordActionOutcome', { actionId: intent.actionId, status: 'succeeded', externalRef: `git:${remote}`, reconciled: true }, SYSTEM);
        return { ok: true, sha: remote, tree: await git(env.workspace.dir, ['rev-parse', 'HEAD^{tree}']) };
      }
      await this.ledger.run('recordActionOutcome', { actionId: intent.actionId, status: 'failed', detail: (e as Error).message.slice(0, 300) }, SYSTEM);
      return { ok: false, error: `Push failed: ${(e as Error).message.slice(0, 300)}` };
    }
  }
}
