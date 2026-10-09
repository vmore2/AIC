// Delegation attenuation — architecture.md §8.9.2 (INV-13).
// Creating more layers of agents can only narrow authority, never widen it.

import type { Mode, RiskTier } from './types.js';
import { modeRank, riskRank } from './types.js';

export interface DelegationScope {
  toolGrants: string[];
  budgetRemaining: number;
  /** The most permissive mode this work may run under (higher rank = more restrictive). */
  autonomyCeiling: Mode;
  riskFloor: RiskTier;
  deadline: string | null;
  depth: number;
}

export interface ChildRequest {
  toolGrants: string[];
  budget: number;
  autonomyCeiling: Mode;
  riskTier: RiskTier;
  deadline: string | null;
}

export interface DelegationLimits { maxDepth: number; maxChildren: number; currentChildren: number }

export const DEFAULT_LIMITS = { maxDepth: 4, maxChildren: 12 } as const;

export function checkAttenuation(parent: DelegationScope, creatorGrants: string[], child: ChildRequest, limits: DelegationLimits): string[] {
  const unmet: string[] = [];
  const allowed = new Set(parent.toolGrants.filter((t) => creatorGrants.includes(t)));
  const extra = child.toolGrants.filter((t) => !allowed.has(t));
  if (extra.length) unmet.push(`tool_grants_exceed_parent(${extra.join(',')})`);
  if (child.budget > parent.budgetRemaining) unmet.push('budget_exceeds_parent_remaining');
  if (child.budget <= 0) unmet.push('budget_positive');
  if (modeRank(child.autonomyCeiling) < modeRank(parent.autonomyCeiling)) unmet.push('autonomy_exceeds_parent');
  if (riskRank(child.riskTier) < riskRank(parent.riskFloor)) unmet.push('risk_below_parent_floor');
  if (parent.deadline && child.deadline && child.deadline > parent.deadline) unmet.push('deadline_after_parent');
  if (parent.depth + 1 > limits.maxDepth) unmet.push('max_depth_exceeded');
  if (limits.currentChildren + 1 > limits.maxChildren) unmet.push('max_children_exceeded');
  return unmet;
}

/** Cycle check over a dependency graph: would adding `dependent -> prerequisite` create a cycle? */
export function wouldCreateCycle(edges: { taskId: string; dependsOn: string }[], dependent: string, prerequisite: string): boolean {
  if (dependent === prerequisite) return true;
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.taskId, [...(adj.get(e.taskId) ?? []), e.dependsOn]);
  // A cycle exists if `dependent` is reachable from `prerequisite` by following dependsOn edges.
  const stack = [prerequisite];
  const seen = new Set<string>();
  while (stack.length) {
    const n = stack.pop()!;
    if (n === dependent) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(adj.get(n) ?? []));
  }
  return false;
}
