// `aic` — the CEO's command line. Runs against the customer's own configuration
// (aic.config.yaml): their database, model providers, and code hosting.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createApp, type App } from '../app.js';
import { DEFAULT_CONFIG_FILE, loadConfig, STARTER_CONFIG } from '../config/config.js';
import { MODE_NAMES, MODES, SYSTEM, type Mode, type Principal } from '../domain/types.js';
import { DomainError, verifyChain } from '../ledger/engine.js';
import { loadDepartments } from '../org/validate.js';
import { profileForRole } from '../runtime/models.js';
import { inbox, objectiveRollups, orgChart, taskDetail } from '../reports/views.js';

const c = {
  b: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`, g: (s: string) => `\x1b[32m${s}\x1b[0m`,
  y: (s: string) => `\x1b[33m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`, cy: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  const multi: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      const val = v ?? (argv[i + 1] && !argv[i + 1]!.startsWith('-') ? argv[++i]! : true);
      flags[k] = val;
      if (typeof val === 'string') (multi[k] ??= []).push(val);
    } else if (a === '-m') flags['m'] = argv[++i] ?? '';
    else pos.push(a);
  }
  return { pos, flags, multi };
}

async function ceo(app: App): Promise<Principal> {
  const u = (await app.ledger.db.query<{ id: string }>(`SELECT id FROM users WHERE role = 'ceo' LIMIT 1`)).rows[0];
  if (!u) throw new Error('Company not initialized. Run `aic init`.');
  // Local CLI sessions act as the CEO on their own machine. Networked deployments authenticate via SSO + MFA.
  return { type: 'user', id: u.id, stepUp: true };
}

const bar = (pct: number, w = 20) => '█'.repeat(Math.round((pct / 100) * w)).padEnd(w, '░');
const deliveryColor = (d: string) => (d === 'done' || d === 'on_track' ? c.g(d.toUpperCase()) : d === 'blocked' ? c.r(d.toUpperCase()) : c.y(d.toUpperCase()));

async function resolveEmployee(app: App, ref: string): Promise<{ id: string; display_name: string }> {
  const r = await app.ledger.db.query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM employees WHERE id = $1 OR role_key = $1 OR lower(display_name) = lower($1) ORDER BY created_at LIMIT 1`, [ref]);
  if (!r.rows[0]) throw new Error(`No employee matches "${ref}". See \`aic team\`.`);
  return r.rows[0];
}

const HELP = `${c.b('aic')} — The AI Company (you bring the infrastructure; the platform governs the work)

${c.b('Setup')}
  aic init [--company "Acme"] [--ceo "Your Name"]   create aic.config.yaml (if missing) and the company ledger
  aic org departments                              list department templates
  aic org show <department>                        roles, structure, workflows, safeguards
  aic org validate [dir]                           check templates against the architecture rules
  aic hire <department>                            hire a department (validates model capabilities)
  aic team                                         org chart with live workload

${c.b('Talk to your team leads')}
  aic chat <employee|role> "message"               a lead answers from the ledger and drafts proposals
  aic directive <id>                               show a drafted proposal
  aic confirm <id> | aic decline <id> -m "why"     confirm or decline it (nothing changes until you confirm)

${c.b('Objectives and plans')}
  aic objective <department> --title "…" --req "REQ-1=…" [--req …] --budget 50 [--set key=value]
  aic run [--timeout 300]                          let the company work until it needs you
  aic inbox                                        everything waiting on you
  aic proposal <id>                                a lead's plan: tasks, owners, criteria, coverage
  aic approve <proposal> [-m "…"] | aic changes <proposal> -m "…"

${c.b('Oversight')}
  aic status                                       objectives: verified vs claimed progress
  aic task <id>                                    claim vs evidence, runs, timeline
  aic accept <task> [-m] | aic reject <task> -m    human acceptance where required
  aic resolve <escalation> "answer"                answer a question / decide a blocker
  aic release <objective>                          approve merging accepted work to main
  aic mode <M1..M6> [--department key] -m "why"    operating mode
  aic stop -m "why" | aic resume [--mode M4] [--ack]   emergency stop / resume
  aic audit                                        verify the tamper-evident ledger

${c.b('Serve')}
  aic serve [--port 4100]                          dashboard + API + orchestrator
`;

async function main() {
  const { pos, flags, multi } = parse(process.argv.slice(2));
  const cmd = pos[0];
  if (!cmd || cmd === 'help' || flags['help']) { console.log(HELP); return; }

  const cfgFile = String(flags['config'] ?? DEFAULT_CONFIG_FILE);
  if (cmd === 'init' && !existsSync(cfgFile)) {
    writeFileSync(cfgFile, STARTER_CONFIG.replace('Acme Inc', String(flags['company'] ?? 'Acme Inc')));
    console.log(`${c.g('✔')} wrote ${cfgFile} — edit it to point at your database, model providers, and code hosting.`);
  }
  if (cmd === 'org' && pos[1] === 'validate') {
    const dir = pos[2] ?? (existsSync(cfgFile) ? loadConfig(cfgFile).templates_path : 'templates/departments');
    const r = loadDepartments(dir);
    for (const f of r.findings) console.log(`${f.level === 'error' ? c.r('error') : c.y('warn ')} ${f.department} ${c.dim(f.rule)} ${f.message}`);
    console.log(`${r.departments.length} departments, ${r.departments.reduce((s, d) => s + d.roles.length, 0)} roles, ${r.findings.filter((f) => f.level === 'error').length} errors`);
    process.exitCode = r.findings.some((f) => f.level === 'error') ? 1 : 0;
    return;
  }

  const config = loadConfig(cfgFile);
  const verbose = !!flags['verbose'];
  const app = await createApp(config, { log: (m) => { if (verbose || /FAILED|UNCERTAIN|awaits|completed|released|conflict/.test(m)) console.log(c.dim(`  · ${m}`)); } });
  try {
    await run(app, cmd, pos, flags, multi);
  } catch (e) {
    if (e instanceof DomainError) {
      console.error(`${c.r('✖')} ${e.message}`);
      const errs = e.details['errors'] as string[] | undefined;
      if (errs) for (const x of errs) console.error(`   - ${x}`);
      process.exitCode = 1;
    } else throw e;
  } finally {
    await app.close();
  }
}

async function run(app: App, cmd: string, pos: string[], flags: Record<string, string | true>, multi: Record<string, string[]>) {
  const { ledger, orchestrator, config } = app;
  const db = ledger.db;
  const msg = typeof flags['m'] === 'string' ? flags['m'] : undefined;
  const templates = () => loadDepartments(config.templates_path).departments;

  switch (cmd) {
    case 'init': {
      const exists = (await db.query('SELECT 1 FROM company')).rows.length;
      if (exists) { console.log('Company already initialized.'); return; }
      await ledger.run('bootstrapCompany', { companyName: config.company.name, ceoName: String(flags['ceo'] ?? 'CEO'), defaultMode: config.defaults.mode, projectSettings: config.defaults.project_settings }, SYSTEM);
      console.log(`${c.g('✔')} ${config.company.name} is ready. Mode: ${config.defaults.mode} (${MODE_NAMES[config.defaults.mode]}).`);
      console.log(`Next: ${c.cy('aic org departments')}, then ${c.cy('aic hire engineering')}.`);
      return;
    }
    case 'org': {
      const deps = templates();
      if (pos[1] === 'departments' || !pos[1]) {
        for (const d of deps) console.log(`${c.b(d.key.padEnd(18))} ${d.name.padEnd(32)} ${String(d.roles.length).padStart(2)} roles  mode ${d.default_mode}  floor ${d.risk_floor}`);
        return;
      }
      if (pos[1] === 'show') {
        const d = deps.find((x) => x.key === pos[2]);
        if (!d) throw new Error(`Unknown department ${pos[2]}`);
        console.log(`${c.b(d.name)} — ${d.purpose.trim()}\n`);
        console.log(c.b('Structure'));
        const print = (parent: string, indent: string) => {
          for (const s of d.structure.filter((x) => x.reports_to === parent)) {
            const r = d.roles.find((x) => x.key === s.role)!;
            console.log(`${indent}${r.title}${s.count > 1 ? ` ×${s.count}` : ''} ${c.dim(`[${r.category}, ${r.rule_of_two_profile}]`)}`);
            print(s.role, indent + '   ');
          }
        };
        console.log('CEO'); print('ceo', '   ');
        console.log(`\n${c.b('Roles')}`);
        for (const r of d.roles) {
          console.log(`  ${c.b(r.title)} (${r.key}) — ${r.charter.trim()}`);
          console.log(c.dim(`    tools: ${r.tools.join(', ')}`));
          for (const cr of r.criteria_templates) console.log(c.dim(`    criterion: ${cr.statement} [${cr.kind}, verified by ${cr.independence}]`));
          if (r.reviewer_role) console.log(c.dim(`    reviewed by: ${r.reviewer_role}`));
        }
        console.log(`\n${c.b('Workflows')}`);
        for (const w of d.workflows) console.log(`  ${w.name}: ${w.stages.map((s) => `${s.key}${s.gate !== 'none' ? `[${s.gate}]` : ''}`).join(' → ')}`);
        console.log(`\n${c.b('Never autonomous')}: ${d.never_autonomous.join('; ') || '—'}`);
        return;
      }
      throw new Error('Usage: aic org departments | show <dept> | validate');
    }
    case 'hire': {
      const d = templates().find((x) => x.key === pos[1]);
      if (!d) throw new Error(`Unknown department "${pos[1]}". See \`aic org departments\`.`);
      const models = Object.fromEntries(d.roles.map((r) => [r.key, profileForRole(config, r.key)]));
      const r = await ledger.run('hireDepartment', { template: d, models }, await ceo(app));
      console.log(`${c.g('✔')} Hired ${d.name}: ${r.employees.length} employees`);
      for (const e of r.employees) console.log(`   ${e.name.padEnd(36)} ${c.dim(e.role)}  model: ${models[e.role]!.key}`);
      return;
    }
    case 'team': {
      for (const d of await orgChart(db)) {
        console.log(`${c.b(d.name)} ${c.dim(`(${d.key}, default mode ${d.default_mode})`)}`);
        const print = (parent: string | null, indent: string) => {
          for (const e of d.employees.filter((x) => x.manager_employee_id === parent)) {
            console.log(`${indent}${e.display_name.padEnd(34 - indent.length)} ${c.dim(e.category.padEnd(10))} active ${e.active}  accepted ${e.accepted}${e.reworkRate !== null ? `  rework ${e.reworkRate}%` : ''}  ${c.dim(e.model_profile)}`);
            print(e.id, indent + '  ');
          }
        };
        print(null, '  ');
      }
      return;
    }
    case 'chat': {
      const emp = await resolveEmployee(app, pos[1] ?? '');
      const text = pos.slice(2).join(' ') || msg;
      if (!text) throw new Error('Usage: aic chat <employee|role> "message"');
      const principal = await ceo(app);
      const existing = (await db.query<{ id: string }>('SELECT id FROM conversations WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 1', [emp.id])).rows[0];
      const conversationId = existing?.id ?? (await ledger.run('startConversation', { employeeId: emp.id }, principal)).conversationId;
      const { runId } = await ledger.run('postMessage', { conversationId, body: text }, principal);
      const turn = await orchestrator.converse(runId);
      console.log(`\n${c.b(emp.display_name)}: ${turn.reply}\n`);
      for (const d of turn.directives) console.log(`${c.y('◆ proposal awaiting your confirmation')} ${d.summary}\n   review: ${c.cy(`aic directive ${d.id}`)}   confirm: ${c.cy(`aic confirm ${d.id}`)}`);
      return;
    }
    case 'directive': {
      const d = (await db.query<{ id: string; directive_type: string; payload: unknown; payload_sha256: string; status: string }>('SELECT * FROM directives WHERE id = $1', [pos[1]])).rows[0];
      if (!d) throw new Error('Directive not found');
      console.log(`${c.b(d.directive_type)} (${d.status})\n${JSON.stringify(d.payload, null, 2)}\n${c.dim(`content hash ${d.payload_sha256}`)}`);
      return;
    }
    case 'confirm': {
      const d = (await db.query<{ payload_sha256: string }>('SELECT payload_sha256 FROM directives WHERE id = $1', [pos[1]])).rows[0];
      if (!d) throw new Error('Directive not found');
      const r = await ledger.run('confirmDirective', { directiveId: pos[1]!, payloadSha256: d.payload_sha256 }, await ceo(app));
      console.log(`${c.g('✔')} Applied. ${JSON.stringify(r.result)}`);
      console.log(`Run ${c.cy('aic run')} — the lead will plan and come back to you with a proposal.`);
      return;
    }
    case 'decline': {
      await ledger.run('rejectDirective', { directiveId: pos[1]!, reason: msg ?? 'declined' }, await ceo(app));
      console.log(`${c.g('✔')} Declined.`);
      return;
    }
    case 'objective': {
      const reqs = (multi['req'] ?? []).map((r, i) => { const m = r.match(/^([A-Z]+-\d+)=(.+)$/s); return m ? { key: m[1]!, text: m[2]!.trim() } : { key: `REQ-${i + 1}`, text: r }; });
      const settings = Object.fromEntries([...Object.entries(config.defaults.project_settings), ...(multi['set'] ?? []).map((s) => s.split('=', 2) as [string, string])]);
      const r = await ledger.run('createObjective', { title: String(flags['title'] ?? ''), departmentKey: pos[1] ?? '', requirements: reqs, budgetUsd: Number(flags['budget'] ?? 50), settings }, await ceo(app));
      console.log(`${c.g('✔')} Objective ${r.objectiveId} created. The department head will propose a plan${r.planApprovalRequired ? ' for your approval' : ''}. Run ${c.cy('aic run')}.`);
      return;
    }
    case 'run': {
      await orchestrator.recoverOrphans();
      const timeout = Number(flags['timeout'] ?? 600) * 1000;
      console.log(c.dim('Working… (Ctrl+C is safe: the ledger keeps the truth; interrupted runs are retried)'));
      await orchestrator.runUntilIdle(timeout);
      const items = await inbox(db);
      console.log(items.length ? `${c.y(`${items.length} item(s) need you`)} — ${c.cy('aic inbox')}` : c.g('Nothing needs you right now.'));
      return;
    }
    case 'inbox': {
      const items = await inbox(db);
      if (!items.length) { console.log(c.g('Inbox zero.')); return; }
      for (const i of items) console.log(`${c.y('●')} ${c.b(i.title)}\n   ${i.detail}\n   ${c.cy(i.command)}`);
      return;
    }
    case 'proposal': {
      const p = (await db.query<{ id: string; status: string; content: { summary: string; tasks: { ref: string; title: string; owner_role: string; kind: string; requirement_keys: string[]; budget_usd: number; depends_on?: string[] }[]; risks: string[]; open_questions: string[] }; validation: { tasks: { ref: string; criteria: { statement: string; kind: string; independence: string }[] }[]; coverage: Record<string, string[]>; warnings: string[] } }>(
        'SELECT * FROM proposals WHERE id = $1', [pos[1]])).rows[0];
      if (!p) throw new Error('Proposal not found');
      console.log(`${c.b('Plan')} (${p.status}): ${p.content.summary}\n`);
      for (const t of p.content.tasks) {
        console.log(`${c.b(t.ref)} ${t.title} ${c.dim(`[${t.kind}] owner ${t.owner_role}  $${t.budget_usd}  covers ${t.requirement_keys.join(',')}${t.depends_on?.length ? `  after ${t.depends_on.join(',')}` : ''}`)}`);
        for (const cr of p.validation.tasks.find((x) => x.ref === t.ref)?.criteria ?? []) console.log(c.dim(`    ✓ ${cr.statement} — ${cr.kind}, verified by ${cr.independence}`));
      }
      console.log(`\n${c.b('Requirement coverage')}: ${Object.entries(p.validation.coverage).map(([k, v]) => `${k}→${v.join(',')}`).join('  ')}`);
      if (p.content.risks.length) console.log(`${c.b('Risks')}: ${p.content.risks.join('; ')}`);
      if (p.content.open_questions.length) console.log(`${c.b('Open questions')}: ${p.content.open_questions.join('; ')}`);
      console.log(`\n${c.cy(`aic approve ${p.id}`)}   or   ${c.cy(`aic changes ${p.id} -m "what to change"`)}`);
      return;
    }
    case 'approve':
    case 'changes': {
      const r = await ledger.run('decideProposal', { proposalId: pos[1]!, decision: cmd === 'approve' ? 'approve' : 'request_changes', rationale: msg }, await ceo(app));
      console.log(`${c.g('✔')} ${cmd === 'approve' ? 'Approved — the plan becomes tasks.' : 'Sent back to the lead with your feedback.'} (${r.status}) Run ${c.cy('aic run')}.`);
      return;
    }
    case 'status': {
      const rolls = await objectiveRollups(db);
      if (!rolls.length) { console.log('No objectives yet. Talk to a lead with `aic chat` or create one with `aic objective`.'); return; }
      for (const o of rolls) {
        console.log(`${c.b(o.title)} ${c.dim(o.department)}  ${deliveryColor(o.delivery)}`);
        console.log(`  verified ${bar(o.verifiedPct)} ${String(o.verifiedPct).padStart(3)}%   claimed ${String(o.claimedPct).padStart(3)}%${o.discrepancy > 0 ? c.y(`  (Δ ${o.discrepancy} unverified)`) : ''}`);
        console.log(c.dim(`  ${o.deliveryReason}  budget $${o.budget.spent.toFixed(2)} / $${o.budget.limit.toFixed(2)}  tasks ${Object.entries(o.tasks.byStatus).map(([k, v]) => `${k}:${v}`).join(' ') || '—'}  decisions waiting: ${o.pendingDecisions}  ${o.id}`));
      }
      return;
    }
    case 'task': {
      const d = await taskDetail(db, pos[1]!);
      const t = d.task;
      console.log(`${c.b(String(t['title']))} ${c.dim(String(t['id']))}\n  status ${c.b(String(t['status']))}${t['hold'] ? c.r(` HOLD ${t['hold']}`) : ''}  risk ${t['risk_tier']}  attempt ${t['attempt']}/${t['max_attempts']}  owner ${t['owner_name']}  ${t['assurance_label'] ? `assurance ${t['assurance_label']}` : ''}`);
      for (const r of d.requirements) console.log(c.dim(`  ${r.key}@v${r.version}: ${r.text}`));
      console.log(`\n${c.b('Claim vs evidence')} (latest submission)`);
      for (const x of d.claimVsEvidence) {
        const v = x.verified === 'passed' ? c.g('passed') : x.verified === 'failed' ? c.r('FAILED') : c.y(x.verified);
        console.log(`  ${x.criterion.slice(0, 70).padEnd(70)} claimed ${String(x.claimed ?? '—').padEnd(13)} verified ${v}${x.claimed === 'met' && x.verified === 'failed' ? c.r('  ⚠ claim contradicted by evidence') : ''}`);
      }
      console.log(`\n${c.b('Submissions')}`);
      d.submissions.forEach((s, n) => console.log(`  #${n + 1} ${s.status.padEnd(10)} claimed ${s.claimedMet} criteria met${s.contradicted ? c.r(` — ${s.contradicted} claim(s) contradicted by independent evidence`) : ''}`));
      console.log(`\n${c.b('Runs')}`);
      for (const r of d.runs) console.log(`  ${r.mode.padEnd(7)} ${r.employee.padEnd(30)} ${r.status}${r.failure_reason ? ` (${r.failure_reason})` : ''}`);
      if (t['status'] === 'awaiting_acceptance') console.log(`\n${c.cy(`aic accept ${t['id']}`)}  or  ${c.cy(`aic reject ${t['id']} -m "…"`)}`);
      return;
    }
    case 'accept':
    case 'reject': {
      const sub = (await db.query<{ submission_sha256: string }>(`SELECT submission_sha256 FROM submissions WHERE task_id = $1 AND status = 'open'`, [pos[1]])).rows[0];
      if (!sub) throw new Error('No open submission for that task');
      const r = cmd === 'accept'
        ? await ledger.run('acceptTask', { taskId: pos[1]!, submissionSha256: sub.submission_sha256, rationale: msg, uncertain: !!flags['uncertain'] }, await ceo(app))
        : await ledger.run('rejectTask', { taskId: pos[1]!, rationale: msg ?? '' }, await ceo(app));
      console.log(`${c.g('✔')} ${r.status}`);
      return;
    }
    case 'resolve': {
      const r = await ledger.run('resolveEscalation', { escalationId: pos[1]!, answer: pos.slice(2).join(' ') || msg || '' }, await ceo(app));
      console.log(`${c.g('✔')} Decision ${r.decisionId} recorded${r.taskStatus ? `; task is now ${r.taskStatus}` : ''}.`);
      return;
    }
    case 'release': {
      const sha = await app.workspaces.remoteSha(`refs/heads/${app.workspaces.integrationBranch(pos[1]!)}`);
      if (!sha) throw new Error('No integration branch for that objective');
      await ledger.run('approveRelease', { objectiveId: pos[1]!, integrationSha: sha, rationale: msg }, await ceo(app));
      await orchestrator.runUntilIdle(120_000);
      const a = (await db.query<{ status: string; external_ref: string | null }>(`SELECT status, external_ref FROM external_actions WHERE action = 'merge_to_base' ORDER BY created_at DESC LIMIT 1`)).rows[0];
      console.log(a?.status === 'succeeded' ? `${c.g('✔')} Released to ${app.workspaces.host.baseBranch} (${a.external_ref}).` : `${c.r('✖')} Release ${a?.status ?? 'not attempted'}.`);
      return;
    }
    case 'mode': {
      const mode = pos[1] as Mode;
      if (!MODES.includes(mode)) throw new Error(`Mode must be one of ${MODES.map((m) => `${m} (${MODE_NAMES[m]})`).join(', ')}`);
      const deptKey = flags['department'];
      const scope = typeof deptKey === 'string'
        ? { scopeType: 'department' as const, scopeId: (await db.query<{ id: string }>('SELECT id FROM departments WHERE key = $1', [deptKey])).rows[0]?.id ?? '' }
        : { scopeType: 'company' as const, scopeId: (await db.query<{ id: string }>('SELECT id FROM company')).rows[0]!.id };
      await ledger.run('setMode', { ...scope, mode, reason: msg ?? '' }, await ceo(app));
      console.log(`${c.g('✔')} ${scope.scopeType} mode is now ${mode} (${MODE_NAMES[mode]}).`);
      return;
    }
    case 'stop': {
      const r = await ledger.run('emergencyStop', { scope: { type: 'company', id: (await db.query<{ id: string }>('SELECT id FROM company')).rows[0]!.id }, reason: msg ?? 'emergency stop' }, await ceo(app));
      console.log(`${c.r('■ STOPPED')} held ${r.heldTasks} tasks, fenced ${r.revokedLeases} runs. Review with ${c.cy('aic inbox')}; resume with ${c.cy('aic resume --ack')}.`);
      return;
    }
    case 'resume': {
      const r = await ledger.run('resumeScope', { scope: { type: 'company', id: (await db.query<{ id: string }>('SELECT id FROM company')).rows[0]!.id },
        mode: (typeof flags['mode'] === 'string' ? flags['mode'] : config.defaults.mode) as Mode, acknowledgeUnresolvedActions: !!flags['ack'], reason: msg ?? 'resume' }, await ceo(app));
      console.log(`${c.g('✔')} Resumed; ${r.released} task(s) released.`);
      return;
    }
    case 'audit': {
      const v = await verifyChain(db);
      console.log(v.ok ? `${c.g('✔')} Ledger hash chain intact (${v.checked} events).` : `${c.r('✖ TAMPERING DETECTED')} chain breaks at event ${v.brokenAt}.`);
      const denials = (await db.query<{ n: string }>(`SELECT count(*) AS n FROM ledger_events WHERE type IN ('command.denied','tool_call.denied')`)).rows[0]!.n;
      console.log(`${denials} denied action(s) recorded.`);
      return;
    }
    case 'serve': {
      const { startServer } = await import('../api/server.js');
      await startServer(app, Number(flags['port'] ?? 4100));
      await new Promise(() => undefined);
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => { console.error(c.r(String((e as Error).stack ?? e))); process.exit(1); });
void path;
