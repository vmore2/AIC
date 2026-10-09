// CEO ↔ team-lead conversations and directives (architecture.md §12.2–12.3).
// Conversation never changes work by itself: a lead can only PROPOSE a structured directive,
// which takes effect when the CEO confirms the exact payload (hash-bound).
import { z } from 'zod';
import { hashOf } from '../../domain/hash.js';
import { newId } from '../../domain/ids.js';
import { DomainError, type Handler } from '../engine.js';
import { getEmployee, getRun } from '../store.js';
import { changeRequirement, createObjective } from './work.js';

export const startConversation: Handler<{ employeeId: string; objectiveId?: string }, { conversationId: string }> = async (c, i) => {
  await c.authorize('conversation.start', { type: 'Employee', id: i.employeeId }, {});
  const emp = await getEmployee(c.q, i.employeeId);
  if (emp.status !== 'active') throw new DomainError('guard_failed', 'Employee is not active');
  const conversationId = newId('cnv');
  await c.q.query('INSERT INTO conversations (id, employee_id, objective_id, created_by) VALUES ($1,$2,$3,$4)', [conversationId, i.employeeId, i.objectiveId ?? null, c.principal.id]);
  c.emit({ type: 'conversation.started', aggregateType: 'conversation', aggregateId: conversationId, payload: { employee_id: i.employeeId } });
  return { conversationId };
};

async function nextSeq(q: { query: <T>(s: string, p?: unknown[]) => Promise<{ rows: T[] }> }, conversationId: string) {
  return Number((await q.query<{ n: string }>('SELECT COALESCE(max(seq), 0) AS n FROM messages WHERE conversation_id = $1', [conversationId])).rows[0]!.n) + 1;
}

/** CEO message → a conversation run for the employee (read-only tools + directive proposals). */
export const postMessage: Handler<{ conversationId: string; body: string }, { messageId: string; runId: string }> = async (c, i) => {
  const conv = (await c.q.query<{ id: string; employee_id: string }>('SELECT * FROM conversations WHERE id = $1', [i.conversationId])).rows[0];
  if (!conv) throw new DomainError('not_found', 'Conversation not found');
  await c.authorize('conversation.post', { type: 'Conversation', id: conv.id }, {});
  if (!i.body.trim()) throw new DomainError('validation', 'Message is empty');
  const messageId = newId('msg');
  await c.q.query(`INSERT INTO messages (id, conversation_id, seq, author_type, author_id, body) VALUES ($1,$2,$3,$4,$5,$6)`,
    [messageId, conv.id, await nextSeq(c.q, conv.id), c.principal.type, c.principal.id, i.body]);
  const emp = await getEmployee(c.q, conv.employee_id);
  const runId = newId('run');
  await c.q.query(`INSERT INTO runs (id, employee_id, mode, model_profile, model_family, status, budget_reserved, conversation_id)
                   VALUES ($1,$2,'conversation',$3,$4,'running',$5,$6)`, [runId, emp.id, emp.model_profile, emp.model_family, 2, conv.id]);
  c.emit({ type: 'conversation.message', aggregateType: 'conversation', aggregateId: conv.id, payload: { message_id: messageId, run_id: runId, from: c.principal.type } });
  return { messageId, runId };
};

export const recordReply: Handler<{ runId: string; body: string }, { messageId: string }> = async (c, i) => {
  await c.authorize('conversation.reply', { type: 'Run', id: i.runId }, {});
  const run = await getRun(c.q, i.runId);
  if (!run.conversation_id) throw new DomainError('validation', 'Not a conversation run');
  const messageId = newId('msg');
  // Citations: ledger records the employee looked at; status claims in replies are advisory, not authoritative.
  await c.q.query(`INSERT INTO messages (id, conversation_id, seq, author_type, author_id, body) VALUES ($1,$2,$3,'employee',$4,$5)`,
    [messageId, run.conversation_id, await nextSeq(c.q, run.conversation_id), run.employee_id, i.body]);
  return { messageId };
};

export const CreateObjectivePayload = z.object({
  title: z.string().min(3),
  requirements: z.array(z.object({ key: z.string().regex(/^[A-Z]+-\d+$/), text: z.string().min(5) })).min(1),
  budget_usd: z.number().positive().max(1_000_000),
  settings: z.record(z.string()).optional(),
});

export const DirectivePayloads = {
  create_objective: CreateObjectivePayload,
  decision: z.object({ question: z.string().min(5), decision: z.string().min(2), objective_id: z.string() }),
  change_requirement: z.object({ objective_id: z.string(), key: z.string().regex(/^[A-Z]+-\d+$/), text: z.string().min(5), reason: z.string().min(3) }),
} as const;
export type DirectiveType = keyof typeof DirectivePayloads;

export const proposeDirective: Handler<{ type: DirectiveType; summary: string; payload: unknown }, { directiveId: string; payloadSha256: string }> = async (c, i) => {
  const run = c.principal.runId ? await getRun(c.q, c.principal.runId) : null;
  const inConversation = !!run && run.mode === 'conversation' && run.status === 'running' && run.employee_id === c.principal.id;
  await c.authorize('directive.propose', { type: 'Conversation', id: run?.conversation_id ?? 'none' }, { in_conversation: inConversation });
  const schema = DirectivePayloads[i.type];
  if (!schema) throw new DomainError('validation', `Unknown directive type ${i.type}`);
  const parsed = schema.safeParse(i.payload);
  if (!parsed.success) throw new DomainError('validation', `Invalid directive payload: ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
  const emp = await getEmployee(c.q, c.principal.id);
  const payload = i.type === 'create_objective' ? { ...parsed.data, department_id: emp.department_id } : parsed.data;
  const directiveId = newId('dir');
  const sha = hashOf({ type: i.type, payload });
  await c.q.query(`INSERT INTO directives (id, conversation_id, proposed_by, directive_type, payload, payload_sha256, status)
                   VALUES ($1,$2,$3,$4,$5,$6,'pending_confirmation')`, [directiveId, run!.conversation_id, c.principal.id, i.type, JSON.stringify({ summary: i.summary, ...payload }), sha]);
  c.emit({ type: 'directive.proposed', aggregateType: 'directive', aggregateId: directiveId, payload: { type: i.type, summary: i.summary, proposed_by: c.principal.id } });
  return { directiveId, payloadSha256: sha };
};

/** The CEO confirms the EXACT structured change (hash-bound); only then does anything happen. */
export const confirmDirective: Handler<{ directiveId: string; payloadSha256: string }, { status: string; result: unknown }> = async (c, i) => {
  const d = (await c.q.query<{ id: string; directive_type: DirectiveType; payload: Record<string, unknown>; payload_sha256: string; status: string }>(
    'SELECT * FROM directives WHERE id = $1 FOR UPDATE', [i.directiveId])).rows[0];
  if (!d) throw new DomainError('not_found', 'Directive not found');
  await c.authorize('directive.confirm', { type: 'Directive', id: d.id }, {});
  if (d.status !== 'pending_confirmation') throw new DomainError('conflict', `Directive is ${d.status}`);
  if (d.payload_sha256 !== i.payloadSha256) throw new DomainError('guard_failed', 'Directive content differs from what was confirmed');
  let result: unknown;
  if (d.directive_type === 'create_objective') {
    const p = d.payload as unknown as z.infer<typeof CreateObjectivePayload> & { department_id: string };
    const key = (await c.q.query<{ key: string }>('SELECT key FROM departments WHERE id = $1', [p.department_id])).rows[0]!.key;
    result = await createObjective(c, { title: p.title, departmentKey: key, requirements: p.requirements, budgetUsd: p.budget_usd, settings: p.settings });
  } else if (d.directive_type === 'change_requirement') {
    const p = d.payload as unknown as z.infer<typeof DirectivePayloads.change_requirement>;
    result = await changeRequirement(c, { objectiveId: p.objective_id, key: p.key, text: p.text, reason: p.reason });
  } else {
    const p = d.payload as { question: string; decision: string; objective_id: string };
    const id = newId('dec');
    await c.q.query(`INSERT INTO decisions (id, scope_type, scope_id, question, decision_text, decided_by_type, decided_by, authority_basis)
                     VALUES ($1,'objective',$2,$3,$4,'user',$5,'directive_confirmation')`, [id, p.objective_id, p.question, p.decision, c.principal.id]);
    result = { decisionId: id };
  }
  await c.q.query(`UPDATE directives SET status = 'applied', confirmed_by = $2, confirmed_at = $3 WHERE id = $1`, [d.id, c.principal.id, c.now.toISOString()]);
  c.emit({ type: 'directive.confirmed', aggregateType: 'directive', aggregateId: d.id, payload: { type: d.directive_type, result } as Record<string, unknown> });
  return { status: 'applied', result };
};

export const rejectDirective: Handler<{ directiveId: string; reason: string }, { status: string }> = async (c, i) => {
  await c.authorize('directive.confirm', { type: 'Directive', id: i.directiveId }, {});
  const r = await c.q.query(`UPDATE directives SET status = 'rejected', confirmed_by = $2, confirmed_at = $3 WHERE id = $1 AND status = 'pending_confirmation' RETURNING id`,
    [i.directiveId, c.principal.id, c.now.toISOString()]);
  if (!r.rows.length) throw new DomainError('conflict', 'Directive is not pending');
  c.emit({ type: 'directive.rejected', aggregateType: 'directive', aggregateId: i.directiveId, payload: { reason: i.reason } });
  return { status: 'rejected' };
};

/** A human approves or rejects a proposed team note (architecture.md §10.4). Notes are advisory context, never authority. */
export const curateNote: Handler<{ noteId: string; decision: 'approve' | 'reject'; reason?: string }, { status: string }> = async (c, i) => {
  await c.authorize('memory.curate', { type: 'MemoryItem', id: i.noteId }, {});
  const n = (await c.q.query<{ id: string; status: string; scope_id: string; tainted: boolean }>(
    `SELECT id, review_status AS status, scope_id, tainted FROM memory_items WHERE id = $1 AND version = 1 FOR UPDATE`, [i.noteId])).rows[0];
  if (!n) throw new DomainError('not_found', 'Note not found');
  if (n.status !== 'proposed') throw new DomainError('conflict', `Note is ${n.status}`);
  const status = i.decision === 'approve' ? 'approved' : 'rejected';
  await c.q.query('UPDATE memory_items SET review_status = $2 WHERE id = $1', [i.noteId, status]);
  c.emit({ type: 'memory.curated', aggregateType: 'memory_item', aggregateId: i.noteId, payload: { decision: status, team: n.scope_id, tainted: n.tainted, reason: i.reason ?? null } });
  return { status };
};
