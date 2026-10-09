import { Ledger } from '../src/ledger/ledger.js';
import { loadDepartments } from '../src/org/validate.js';
import type { ModelProfile } from '../src/config/config.js';
import type { Department } from '../src/org/schema.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';

export const departments = loadDepartments('templates/recommended').departments;
export const dept = (k: string): Department => structuredClone(departments.find((d) => d.key === k)!);

export const profile = (key: string, family: string): ModelProfile => ({
  key, provider: 'scripted', model: key, family, context_tokens: 200000, structured_output: true, tool_calling: true, price_per_million: { input: 1, output: 1 },
});

/** Producers on one model family, reviewers on another (independence for R2). */
export function modelsFor(d: Department): Record<string, ModelProfile> {
  return Object.fromEntries(d.roles.map((r) => [r.key, r.category === 'reviewer' ? profile('rev', 'family-b') : profile('main', 'family-a')]));
}

export async function setupCompany(mode: 'M1' | 'M4' = 'M4') {
  const ledger = await Ledger.open({});
  const { ceoUserId } = await ledger.run('bootstrapCompany', { companyName: 'Test Co', ceoName: 'Casey CEO', defaultMode: mode }, SYSTEM);
  const ceo: Principal = { type: 'user', id: ceoUserId, stepUp: true };
  const eng = dept('engineering');
  const hired = await ledger.run('hireDepartment', { template: eng, models: modelsFor(eng) }, ceo);
  if (mode === 'M1') await ledger.run('setMode', { scopeType: 'department', scopeId: hired.departmentId, mode: 'M1', reason: 'test autonomy' }, ceo);
  const byRole = (r: string) => hired.employees.filter((e) => e.role === r).map((e) => e.id);
  return { ledger, ceo, hired, byRole };
}

export const emp = (id: string, runId: string, epoch: number): Principal => ({ type: 'employee', id, runId, epoch });
export { SYSTEM };
