// Platform tool catalog — architecture.md Appendix D.
// Each tool has a fixed action class (risk), an output taint, and whether the platform
// ships it ("builtin") or the customer supplies it through a connector ("connector").
import type { ActionClass } from '../domain/types.js';

export type Taint = 'trusted' | 'internal' | 'untrusted';
/** Data-flow traits used for Rule-of-Two analysis (§16.4). */
export type Trait = 'reads_untrusted' | 'reads_private' | 'external_comms' | 'state_change';

export interface ToolDef {
  name: string;
  actionClass: ActionClass;
  outputTaint: Taint;
  source: 'builtin' | 'connector';
  traits: Trait[];
  description: string;
}

const t = (name: string, actionClass: ActionClass, outputTaint: Taint, source: ToolDef['source'], traits: Trait[], description: string): ToolDef =>
  ({ name, actionClass, outputTaint, source, traits, description });

export const TOOL_CATALOG: readonly ToolDef[] = [
  // Ledger tools: the only way an employee affects authoritative state (all mediated by the Transition Engine).
  t('ledger.get_task_contract', 'A0', 'trusted', 'builtin', [], 'Read the authoritative Task Contract: verbatim requirements, criteria, constraints, budget.'),
  t('ledger.get_team_board', 'A0', 'trusted', 'builtin', [], 'Managers: inspect the real state of every task in your subtree.'),
  t('ledger.submit_work', 'A2', 'trusted', 'builtin', [], 'Submit artifacts for independent verification. This never marks a task complete.'),
  t('ledger.raise_blocker', 'A2', 'trusted', 'builtin', [], 'Report a blocker with options; suspends your run until resolved.'),
  t('ledger.ask_question', 'A2', 'trusted', 'builtin', [], 'Ask your manager or the CEO a clarifying question.'),
  t('ledger.propose_plan', 'A2', 'trusted', 'builtin', [], 'Managers: propose a plan (tasks, criteria, owners, dependencies) to the CEO as a formal proposal.'),
  t('ledger.create_subtask', 'A2', 'trusted', 'builtin', [], 'Managers: create a subtask within your approved scope (attenuated permissions).'),
  t('ledger.assign_task', 'A2', 'trusted', 'builtin', [], 'Managers: assign or reassign a task to one of your reports.'),
  t('ledger.post_update', 'A2', 'trusted', 'builtin', [], 'Post a progress note. Displayed as a claim, not as status.'),
  t('ledger.propose_directive', 'A2', 'trusted', 'builtin', [], 'In conversation: propose a structured change for the CEO to confirm.'),
  t('review.record_verdict', 'A2', 'trusted', 'builtin', [], 'Reviewers: record a per-criterion verdict with concrete findings.'),
  // Knowledge
  t('knowledge.search', 'A0', 'internal', 'builtin', ['reads_private'], 'Search team/project knowledge you are authorized to read.'),
  t('knowledge.remember', 'A1', 'trusted', 'builtin', [], 'Save a private lesson with its source.'),
  t('knowledge.propose_team_note', 'A1', 'trusted', 'builtin', [], 'Propose a note for the whole team (a human approves it before teammates see it).'),
  // Workspace / code
  t('fs.read', 'A0', 'internal', 'builtin', ['reads_private'], 'Read a file in your run workspace.'),
  t('fs.write', 'A1', 'trusted', 'builtin', [], 'Write a file in your run workspace.'),
  t('fs.list', 'A0', 'internal', 'builtin', ['reads_private'], 'List files in your run workspace.'),
  t('sandbox.exec', 'A1', 'internal', 'builtin', [], 'Run a command in your isolated workspace.'),
  t('repo.commit_and_push', 'A4', 'trusted', 'builtin', ['state_change'], 'Commit workspace changes and push your run branch.'),
  t('repo.open_pr', 'A4', 'trusted', 'connector', ['state_change'], 'Open a pull request from your run branch.'),
  t('repo.merge_pr', 'A5', 'trusted', 'connector', ['state_change'], 'Merge a pull request into a protected branch (approval required).'),
  t('deploy.request', 'A5', 'trusted', 'connector', ['state_change'], 'Request a deployment (R3: human pre-approval).'),
  // External content (untrusted by definition)
  t('web.search', 'A0', 'untrusted', 'connector', ['reads_untrusted'], 'Search the public web.'),
  t('web.fetch', 'A0', 'untrusted', 'connector', ['reads_untrusted'], 'Fetch a public web page.'),
  t('docs.read_external', 'A0', 'untrusted', 'connector', ['reads_untrusted'], 'Read customer- or third-party-provided documents.'),
  t('email.read_inbound', 'A0', 'untrusted', 'connector', ['reads_untrusted', 'reads_private'], 'Read inbound email.'),
  // Communication / business systems
  t('email.draft', 'A1', 'trusted', 'builtin', [], 'Draft an email (not sent).'),
  t('email.send_external', 'A5', 'trusted', 'connector', ['external_comms'], 'Send an email outside the company (approval required).'),
  t('chat.post_internal', 'A4', 'trusted', 'connector', ['state_change'], 'Post to an internal team channel.'),
  t('ticket.create', 'A4', 'trusted', 'connector', ['state_change'], 'Create a ticket in the issue tracker.'),
  t('ticket.read', 'A0', 'internal', 'connector', ['reads_private'], 'Read tickets.'),
  t('crm.read', 'A0', 'internal', 'connector', ['reads_private'], 'Read CRM records.'),
  t('crm.update', 'A4', 'trusted', 'connector', ['state_change'], 'Update CRM records.'),
  t('support.reply_customer', 'A5', 'trusted', 'connector', ['external_comms'], 'Send a reply to a customer (approval or standing approval).'),
  t('social.publish', 'A5', 'trusted', 'connector', ['external_comms'], 'Publish content to an external channel.'),
  t('design.read', 'A0', 'internal', 'connector', ['reads_private'], 'Read design files.'),
  t('design.write', 'A4', 'trusted', 'connector', ['state_change'], 'Create or update design files.'),
  t('analytics.query', 'A0', 'internal', 'connector', ['reads_private'], 'Run read-only analytics queries.'),
  t('finance.read_ledger', 'A0', 'internal', 'connector', ['reads_private'], 'Read accounting records.'),
  t('finance.post_entry', 'A5', 'trusted', 'connector', ['state_change'], 'Post a journal entry (approval required).'),
  t('payments.execute', 'A6', 'trusted', 'connector', ['state_change', 'external_comms'], 'Execute a payment (two-person human approval).'),
  t('hris.read', 'A0', 'internal', 'connector', ['reads_private'], 'Read HR records (restricted).'),
  t('hris.update', 'A5', 'trusted', 'connector', ['state_change'], 'Update HR records (approval required).'),
  t('contracts.read', 'A0', 'internal', 'connector', ['reads_private'], 'Read contracts.'),
  t('calendar.schedule', 'A4', 'trusted', 'connector', ['state_change', 'external_comms'], 'Schedule meetings.'),
];

export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(TOOL_CATALOG.map((d) => [d.name, d]));

export function toolTraits(names: string[]): Set<Trait> {
  return new Set(names.flatMap((n) => TOOLS_BY_NAME.get(n)?.traits ?? []));
}
