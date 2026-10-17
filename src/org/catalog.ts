// Team catalog: the platform's recommended teams + the company's own custom teams.
// Both formats are accepted: the short "team spec" (roles only) and the full department template.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { DepartmentSchema, type Department } from './schema.js';
import { compileTeam, isTeamSpec, starterSpec } from './teamSpec.js';
import { validateDepartment, validateOrganization, type Finding } from './validate.js';

/** Recommended teams ship with the platform (curated by AIC). */
export const RECOMMENDED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../templates/recommended');

export interface CatalogEntry {
  key: string;
  name: string;
  source: 'recommended' | 'custom';
  format: 'team_spec' | 'full';
  file: string;
  department?: Department;
  errors: string[];
  warnings: string[];
  notes: string[];
}

export function loadTeamFile(file: string, source: CatalogEntry['source']): CatalogEntry {
  const base = { key: path.basename(file).replace(/\.ya?ml$/, ''), name: path.basename(file), source, file, errors: [] as string[], warnings: [] as string[], notes: [] as string[] };
  let raw: unknown;
  try { raw = parseYaml(readFileSync(file, 'utf8')); } catch (e) { return { ...base, format: 'full', errors: [`YAML error: ${(e as Error).message}`] }; }
  return entryFrom(raw, source, file);
}

export function entryFrom(raw: unknown, source: CatalogEntry['source'], file: string): CatalogEntry {
  const base = { key: path.basename(file).replace(/\.ya?ml$/, ''), name: path.basename(file), source, file, warnings: [] as string[] };
  if (isTeamSpec(raw)) {
    const r = compileTeam(raw);
    if (!r.department) return { ...base, format: 'team_spec', errors: r.errors, notes: r.notes };
    return finish({ ...base, key: r.department.key, name: r.department.name, format: 'team_spec', department: r.department, errors: r.errors, notes: r.notes });
  }
  const parsed = DepartmentSchema.safeParse(raw);
  if (!parsed.success) return { ...base, format: 'full', errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), notes: [] };
  return finish({ ...base, key: parsed.data.key, name: parsed.data.name, format: 'full', department: parsed.data, errors: [], notes: [] });
}

function finish(e: CatalogEntry): CatalogEntry {
  if (!e.department) return e;
  const findings = validateDepartment(e.department);
  return { ...e, errors: [...e.errors, ...findings.filter((f) => f.level === 'error').map(fmt)], warnings: [...e.warnings, ...findings.filter((f) => f.level === 'warning').map(fmt)] };
}
const fmt = (f: Finding) => `${f.message} (${f.rule})`;

function readDir(dir: string, source: CatalogEntry['source']): CatalogEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => loadTeamFile(path.join(dir, f), source));
}

export interface Catalog { entries: CatalogEntry[]; get(key: string): CatalogEntry | undefined }

/** Custom teams override recommended ones with the same key (the company's version wins). */
export function loadCatalog(customDir: string, recommendedDir = RECOMMENDED_DIR): Catalog {
  const recommended = readDir(recommendedDir, 'recommended');
  const custom = readDir(customDir, 'custom');
  const customKeys = new Set(custom.map((c) => c.key));
  const entries = [...recommended.filter((r) => !customKeys.has(r.key)), ...custom];
  // Cross-team rules (e.g. role keys unique across the company).
  const deps = entries.filter((e) => e.department && !e.errors.length).map((e) => e.department!);
  for (const f of validateOrganization(deps).filter((x) => x.rule === 'global_role_unique' || x.rule === 'department_unique')) {
    const e = entries.find((x) => x.key === f.department);
    if (e) e.errors.push(`${f.message} — give the role an explicit "key" (${f.rule})`);
  }
  return { entries, get: (key) => entries.find((e) => e.key === key) };
}

export function scaffoldTeam(customDir: string, key: string, name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error('Team key must be snake_case, e.g. growth_marketing');
  mkdirSync(customDir, { recursive: true });
  const file = path.join(customDir, `${key}.yaml`);
  if (existsSync(file)) throw new Error(`${file} already exists`);
  writeFileSync(file, starterSpec(key, name));
  return file;
}

export function saveTeamSpec(customDir: string, key: string, yamlText: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error('Team key must be snake_case');
  mkdirSync(customDir, { recursive: true });
  const file = path.join(customDir, `${key}.yaml`);
  writeFileSync(file, yamlText);
  return file;
}
