// Ledger facade: a typed registry of every command the platform accepts.
// There is intentionally no generic "update" or "set status" entry point (§14.8).
import { newId } from '../domain/ids.js';
import type { Principal } from '../domain/types.js';
import { Pdp } from '../policy/pdp.js';
import { migrate, openPglite, openPostgres, type Db } from './db.js';
import { Engine, type Handler } from './engine.js';
import * as org from './commands/org.js';
import * as work from './commands/work.js';
import * as ver from './commands/verification.js';
import * as gov from './commands/governance.js';
import * as talk from './commands/interaction.js';

export const COMMANDS = {
  bootstrapCompany: org.bootstrapCompany,
  addUser: org.addUser,
  issueAccessToken: org.issueAccessToken,
  revokeAccessToken: org.revokeAccessToken,
  hireDepartment: org.hireDepartment,
  setMode: org.setMode,
  createObjective: work.createObjective,
  markReady: work.markReady,
  dispatchTask: work.dispatchTask,
  renewLease: work.renewLease,
  recordUsage: work.recordUsage,
  endRun: work.endRun,
  submitWork: work.submitWork,
  proposePlan: work.proposePlan,
  raiseEscalation: work.raiseEscalation,
  resolveEscalation: work.resolveEscalation,
  postUpdate: work.postUpdate,
  recordToolCall: work.recordToolCall,
  acceptTask: work.acceptTask,
  rejectTask: work.rejectTask,
  decideProposal: work.decideProposal,
  materializePlan: work.materializePlan,
  cancelTask: work.cancelTask,
  retryTask: work.retryTask,
  reopenTask: work.reopenTask,
  completeObjective: work.completeObjective,
  approveRelease: work.approveRelease,
  changeRequirement: work.changeRequirement,
  reassignTask: work.reassignTask,
  recordCiResult: work.recordCiResult,
  startVerification: ver.startVerification,
  recordEvidence: ver.recordEvidence,
  evaluateTask: ver.evaluateTask,
  requeueAfterChanges: ver.requeueAfterChanges,
  assignReview: ver.assignReview,
  emergencyStop: gov.emergencyStop,
  resumeScope: gov.resumeScope,
  recordActionIntent: gov.recordActionIntent,
  recordActionOutcome: gov.recordActionOutcome,
  startConversation: talk.startConversation,
  postMessage: talk.postMessage,
  recordReply: talk.recordReply,
  proposeDirective: talk.proposeDirective,
  confirmDirective: talk.confirmDirective,
  rejectDirective: talk.rejectDirective,
  curateNote: talk.curateNote,
} as const;

export type CommandName = keyof typeof COMMANDS;
export type CommandInput<K extends CommandName> = (typeof COMMANDS)[K] extends Handler<infer I, unknown> ? I : never;
export type CommandOutput<K extends CommandName> = (typeof COMMANDS)[K] extends Handler<never, infer O> ? O : never;

export class Ledger {
  constructor(readonly db: Db, readonly engine: Engine) {}

  static async open(opts: { localPath?: string; url?: string; policyDir?: string; clock?: () => Date }): Promise<Ledger> {
    const db = opts.url ? await openPostgres(opts.url) : await openPglite(opts.localPath);
    await migrate(db);
    return new Ledger(db, new Engine(db, new Pdp(opts.policyDir), opts.clock));
  }

  /** Execute a command. Supply a stable `key` when retrying the same intent (idempotency). */
  run<K extends CommandName>(name: K, input: CommandInput<K>, principal: Principal, key: string = newId('cmd')): Promise<CommandOutput<K>> {
    return this.engine.execute(name, COMMANDS[name] as unknown as Handler<CommandInput<K>, CommandOutput<K>>, input, principal, key);
  }

  close() { return this.db.close(); }
}
