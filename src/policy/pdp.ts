// Policy Decision Point — Cedar, embedded in-process (architecture.md §6.4, D4).
// Fail closed (INV-16): any evaluation error, parse error, or exception is a DENY.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import type { Principal } from '../domain/types.js';

export interface AuthzContext {
  mode: string;
  action_class: string;
  gate: 'allow' | 'manager' | 'human' | 'blocked';
  is_owner: boolean;
  epoch_current: boolean;
  stale_epoch: boolean;
  manages_scope: boolean;
  is_assigned_reviewer: boolean;
  in_conversation: boolean;
  tool_granted: boolean;
  approval_valid: boolean;
  task_held: boolean;
  in_producer_lineage: boolean;
}

export const DEFAULT_CONTEXT: AuthzContext = {
  mode: 'M1', action_class: 'A0', gate: 'allow', is_owner: false, epoch_current: false, stale_epoch: false,
  manages_scope: false, is_assigned_reviewer: false, in_conversation: false, tool_granted: false,
  approval_valid: false, task_held: false, in_producer_lineage: false,
};

export interface PrincipalAttrs { role: string; can_manage: boolean; step_up: boolean }

export interface AuthzRequest {
  principal: Principal;
  attrs: PrincipalAttrs;
  action: string;
  resource: { type: string; id: string };
  context: Partial<AuthzContext>;
}

export interface AuthzDecision { allowed: boolean; reasons: string[]; errors: string[] }

const BASELINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'baseline.cedar');

export class Pdp {
  private readonly policies: string;

  constructor(extraPolicyDir?: string) {
    const parts = [readFileSync(BASELINE, 'utf8')];
    if (extraPolicyDir && existsSync(extraPolicyDir)) {
      for (const f of readdirSync(extraPolicyDir).filter((f) => f.endsWith('.cedar')).sort())
        parts.push(readFileSync(path.join(extraPolicyDir, f), 'utf8'));
    }
    this.policies = parts.join('\n');
    const check = cedar.checkParsePolicySet({ staticPolicies: this.policies });
    if (check.type !== 'success') throw new Error(`Policy set failed to parse: ${JSON.stringify(check.errors)}`);
  }

  authorize(req: AuthzRequest): AuthzDecision {
    const entityType = req.principal.type === 'user' ? 'User' : req.principal.type === 'employee' ? 'Employee' : 'System';
    const context = { ...DEFAULT_CONTEXT, ...req.context };
    try {
      const res = cedar.isAuthorized({
        principal: { type: entityType, id: req.principal.id },
        action: { type: 'Action', id: req.action },
        resource: { type: req.resource.type, id: req.resource.id },
        context: context as unknown as Record<string, cedar.CedarValueJson>,
        policies: { staticPolicies: this.policies },
        entities: [{ uid: { type: entityType, id: req.principal.id }, attrs: { ...req.attrs }, parents: [] }],
      });
      if (res.type !== 'success') return { allowed: false, reasons: [], errors: res.errors.map((e) => e.message) };
      const errors = res.response.diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`);
      // Fail closed: an erroring policy could be a forbid that silently failed to apply.
      if (errors.length) return { allowed: false, reasons: res.response.diagnostics.reason, errors };
      return { allowed: res.response.decision === 'allow', reasons: res.response.diagnostics.reason, errors };
    } catch (e) {
      return { allowed: false, reasons: [], errors: [(e as Error).message] };
    }
  }
}
