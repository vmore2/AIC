// Scripted model — a deterministic, offline stand-in for a real LLM. It exists so the platform
// can be demonstrated and tested without network calls or cost. It plays roles convincingly only
// for the bundled demo scenarios; for real work a customer configures their own model profile.
// It talks to the platform exactly like a real model: through tool calls the Tool Gateway authorizes.
import type { ModelProfile } from '../config/config.js';
import type { TaskContract } from './context.js';
import type { ChatMessage, ModelPort, ModelRequest, ModelResponse, ToolCall } from './modelPort.js';
import { toProviderName } from './gateway.js';

export interface Persona { roleKey: string; category: string; mode: 'task' | 'review' | 'conversation' }

let callSeq = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `call_${++callSeq}`, name: toProviderName(name), arguments: args });
const reply = (toolCalls: ToolCall[], text = ''): ModelResponse => ({ text, toolCalls, usage: { inputTokens: 0, outputTokens: 0 } });

function firstJson<T>(messages: ChatMessage[]): T {
  const first = messages[0];
  const text = first && first.role === 'user' ? first.content : '{}';
  const start = text.indexOf('{');
  return JSON.parse(text.slice(start)) as T;
}
const toolResults = (m: ChatMessage[]) => m.filter((x): x is Extract<ChatMessage, { role: 'tool' }> => x.role === 'tool');
const lastTool = (m: ChatMessage[]) => toolResults(m).at(-1);

export class ScriptedModel implements ModelPort {
  constructor(readonly profile: ModelProfile, private readonly persona: Persona) {}

  async generate(req: ModelRequest): Promise<ModelResponse> {
    if (this.persona.mode === 'review') return review(req.messages);
    if (this.persona.mode === 'conversation') return converse(req.messages, req.tools.map((t) => t.name));
    const contract = firstJson<TaskContract>(req.messages);
    if (contract.task.kind === 'planning') return plan(contract, req.messages);
    return work(contract, req.messages, this.persona);
  }
}

// ---------------------------------------------------------------- team lead: planning

function plan(c: TaskContract, messages: ChatMessage[]): ModelResponse {
  const results = toolResults(messages);
  if (results.length && results.at(-1)!.content.startsWith('ERROR')) return reply([], 'My plan failed validation; I need a human to adjust the objective.');
  if (results.length) return reply([], 'Plan submitted for CEO approval.');
  const brief = c.planning!;
  const team = brief.your_team.filter((t) => t.category !== 'manager' && t.category !== 'reviewer');
  const impl = team.find((t) => t.category === 'specialist' && (t.task_kinds.includes('implementation') || t.task_kinds.includes('research'))) ?? team[0]!;
  const qa = team.find((t) => t.category === 'qa' && t.task_kinds.includes('implementation'));
  const kind = impl.task_kinds.includes('implementation') ? 'implementation' : 'research';
  const share = Math.max(1, Math.floor((brief.budget_available_usd * 0.6) / (c.requirements.length + (qa ? 1 : 0))));
  const tasks: Record<string, unknown>[] = c.requirements.map((r, i) => ({
    ref: `t${i + 1}`, title: `Deliver ${r.key}`, kind, owner_role: impl.role, requirement_keys: [r.key], budget_usd: share,
    spec: `Deliver ${r.key} exactly as written: "${r.text}". Follow the acceptance criteria; add tests or evidence for each one.`,
  }));
  if (qa) tasks.push({ ref: 'qa', title: 'Independent acceptance tests', kind: 'implementation', owner_role: qa.role, depends_on: tasks.map((t) => t['ref']),
    requirement_keys: c.requirements.map((r) => r.key), budget_usd: share,
    spec: `Write acceptance tests for ${c.requirements.map((r) => r.key).join(', ')} directly from the requirement text, without relying on the implementation's own tests.` });
  return reply([call('ledger.propose_plan', { plan: {
    summary: `Deliver ${c.requirements.length} requirement(s) for "${c.objective.title}" with ${impl.title} work${qa ? ' and independent QA' : ''}.`,
    tasks, risks: ['Requirements may be ambiguous; owners will escalate rather than guess.'], open_questions: [],
    estimate: { cost_usd: share * tasks.length },
  } })]);
}

// ---------------------------------------------------------------- specialists: producing deliverables

interface Skill { matches(text: string): boolean; files(attempt: number, role: Persona): Record<string, string> }

const SLUGIFY: Skill = {
  matches: (t) => /slugify/i.test(t),
  files: (attempt, p): Record<string, string> => {
    if (p.category === 'qa') return {
      'test/slugify.acceptance.test.js': `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slugify.js';\n\n` +
        `test('REQ: lowercase words joined by single hyphens', () => assert.equal(slugify('Hello World'), 'hello-world'));\n` +
        `test('REQ: punctuation removed and repeats collapsed', () => assert.equal(slugify('Rock & Roll!!  Now'), 'rock-roll-now'));\n` +
        `test('REQ: no leading or trailing hyphens', () => assert.equal(slugify('  --Edge Case--  '), 'edge-case'));\n`,
    };
    // Attempt 1 ships a subtle bug (leading/trailing hyphens survive) and does not run its tests —
    // the kind of confident, unverified claim the platform is designed to catch.
    const body = attempt <= 1
      ? `export function slugify(text) {\n  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-');\n}\n`
      : `export function slugify(text) {\n  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n}\n`;
    return {
      'src/slugify.js': body,
      'test/slugify.test.js': `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/slugify.js';\n\n` +
        `test('basic', () => assert.equal(slugify('Hello World'), 'hello-world'));\n` +
        `test('trims hyphens', () => assert.equal(slugify('  Hello, World!  '), 'hello-world'));\n`,
      'package.json': `{\n  "name": "deliverables",\n  "type": "module",\n  "private": true,\n  "scripts": { "test": "node --test" }\n}\n`,
    };
  },
};

function documentFor(path: string, sections: string[], c: TaskContract): string {
  const reqs = c.requirements.map((r) => `- ${r.key} (v${r.version}): ${r.text}`).join('\n');
  const body = (s: string) => {
    switch (s.toLowerCase()) {
      case 'sources': case 'evidence': case 'policy references': return `Every statement below traces to the pinned requirements of task ${c.task.id}:\n${reqs}`;
      case 'open questions': case 'questions for counsel': case 'contradictions': return 'None identified at this time; any new ambiguity will be escalated rather than assumed.';
      default: return `${c.task.spec}\n\nThis section addresses: ${c.requirements.map((r) => r.key).join(', ')}.`;
    }
  };
  return `# ${c.task.title}\n\n` + sections.map((s) => `## ${s}\n\n${body(s)}\n`).join('\n');
}

function work(c: TaskContract, messages: ChatMessage[], persona: Persona): ModelResponse {
  const results = toolResults(messages);
  const last = lastTool(messages);
  const skill = [SLUGIFY].find((s) => s.matches(`${c.task.spec} ${c.requirements.map((r) => r.text).join(' ')}`));
  const files: Record<string, string> = {};
  for (const cr of c.acceptance_criteria) {
    const check = cr.check as { type: string; path?: string; sections?: string[] } | undefined;
    if (check?.type === 'markdown_sections' && check.path) files[check.path] = documentFor(check.path, check.sections ?? [], c);
    if ((check?.type === 'file_exists' || check?.type === 'no_placeholder_text') && check.path && !files[check.path]) files[check.path] = documentFor(check.path, ['Summary', 'Content'], c);
  }
  const needsCode = c.acceptance_criteria.some((cr) => (cr.check as { type?: string } | undefined)?.type === 'command');
  if (needsCode && skill) Object.assign(files, skill.files(c.task.attempt, persona));
  if (needsCode && !skill && results.length === 0) {
    return reply([call('ledger.raise_blocker', { type: 'blocker',
      question: 'This task needs real implementation work, but this employee is running on the offline scripted model. Configure a real model profile for this role, then resolve this blocker.',
      recommendation: 'Assign an OpenAI-compatible or Anthropic model profile to this role in aic.config.yaml.' })]);
  }

  const writes = Object.entries(files);
  if (results.length < writes.length) {
    const [p, content] = writes[results.length]!;
    return reply([call('fs.write', { path: p, content })]);
  }
  // Attempt 2+: run the tests before claiming anything (learned from the verification feedback).
  const ranTests = results.some((r) => r.name.endsWith('sandbox__exec'));
  if (needsCode && c.task.attempt >= 2 && !ranTests) return reply([call('sandbox.exec', { command: 'node --test', timeout_s: 120 })]);
  if (last?.name.endsWith('submit_work')) return reply([], 'Submitted.');
  return reply([call('ledger.submit_work', {
    summary: `Completed "${c.task.title}" (attempt ${c.task.attempt}).`,
    per_criterion: c.acceptance_criteria.map((cr) => ({ criterion_id: cr.id, self_assessment: 'met' })),
    known_gaps: [],
  })]);
}

// ---------------------------------------------------------------- reviewers

function review(messages: ChatMessage[]): ModelResponse {
  if (toolResults(messages).length) return reply([], 'Review recorded.');
  const ctx = firstJson<{ criteria_to_judge: { id: string; statement: string }[]; change: string }>(messages);
  const lines = ctx.change.split('\n');
  const todo = lines.findIndex((l) => l.startsWith('+') && /TODO|FIXME/.test(l));
  return reply([call('review.record_verdict', {
    verdicts: ctx.criteria_to_judge.map((cr) => todo >= 0
      ? { criterion_id: cr.id, verdict: 'fail', confidence: 0.7, findings: [{ location: `diff line ${todo + 1}`, description: 'Unfinished work (TODO/FIXME) left in the change.', severity: 'major' }] }
      : { criterion_id: cr.id, verdict: 'pass', confidence: 0.8, findings: [] }),
  })]);
}

// ---------------------------------------------------------------- conversations with the CEO

function converse(messages: ChatMessage[], tools: string[]): ModelResponse {
  const results = toolResults(messages);
  if (!results.length && tools.includes(toProviderName('ledger.get_team_board'))) return reply([call('ledger.get_team_board', {})]);
  let board: { tasks?: { title: string; status: string; owner: string | null }[] } = {};
  try { board = JSON.parse(results.at(-1)?.content ?? '{}'); } catch { /* ignore */ }
  const tasks = board.tasks ?? [];
  const lines = tasks.map((t) => `- ${t.title}: ${t.status}${t.owner ? ` (${t.owner})` : ''}`).join('\n');
  return reply([], tasks.length
    ? `Here is where my team stands, straight from the ledger:\n${lines}\n\nIf you want new work, create an objective with requirements and I will come back with a plan for your approval.`
    : 'My team has no active tasks. Give me an objective with your requirements and I will propose a plan for your approval.');
}
