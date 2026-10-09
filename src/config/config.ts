// Customer configuration. The AI Company hosts nothing: each company supplies its own
// database, model providers and keys, and code hosting. Secrets are referenced by
// environment-variable name and never stored in config files or the ledger.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { MODES } from '../domain/types.js';

export const ModelProfileSchema = z.object({
  key: z.string(),
  provider: z.enum(['openai_compatible', 'anthropic', 'scripted']),
  model: z.string(),
  base_url: z.string().url().optional(),
  api_key_env: z.string().optional(),
  /** Lineage grouping used for reviewer independence (e.g. "openai", "anthropic", "llama"). */
  family: z.string(),
  context_tokens: z.number().int().positive().default(128000),
  structured_output: z.boolean().default(true),
  tool_calling: z.boolean().default(true),
  /** Customer-supplied prices; the platform never hard-codes vendor pricing. */
  price_per_million: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }).default({ input: 0, output: 0 }),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const ConfigSchema = z.object({
  company: z.object({ name: z.string() }),
  database: z.union([
    z.object({ url_env: z.string() }),
    z.object({ local_path: z.string() }),
  ]).default({ local_path: '.aic/db' }),
  models: z.object({
    profiles: z.array(ModelProfileSchema).min(1),
    /** Role key → profile key. `default` applies to unmapped roles. */
    assignments: z.record(z.string()).default({}),
    default: z.string(),
  }),
  code_hosting: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), path: z.string() }),
    z.object({ kind: z.literal('github'), repo: z.string(), token_env: z.string(), base_branch: z.string().default('main') }),
  ]).default({ kind: 'local', path: '.aic/repo' }),
  defaults: z.object({
    mode: z.enum(MODES).default('M4'),
    project_settings: z.record(z.string()).default({ test_command: 'npm test' }),
  }).default({}),
  /** Where run workspaces and transcripts are stored (customer storage). */
  storage_path: z.string().default('.aic/storage'),
  templates_path: z.string().default('templates/departments'),
  /** Signs run credentials; supply via env in production. */
  credential_secret_env: z.string().default('AIC_CREDENTIAL_SECRET'),
});
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG_FILE = 'aic.config.yaml';

export function loadConfig(file = DEFAULT_CONFIG_FILE, baseDir = process.cwd()): Config {
  const full = path.resolve(baseDir, file);
  if (!existsSync(full)) throw new Error(`Config not found at ${full}. Run \`aic init\` to create one.`);
  const cfg = ConfigSchema.parse(parseYaml(readFileSync(full, 'utf8')));
  const base = path.dirname(full);
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(base, p));
  if ('local_path' in cfg.database) cfg.database = { local_path: abs(cfg.database.local_path) };
  if (cfg.code_hosting.kind === 'local') cfg.code_hosting = { ...cfg.code_hosting, path: abs(cfg.code_hosting.path) };
  cfg.storage_path = abs(cfg.storage_path);
  cfg.templates_path = abs(cfg.templates_path);
  const keys = new Set(cfg.models.profiles.map((p) => p.key));
  for (const [role, key] of Object.entries(cfg.models.assignments)) if (!keys.has(key)) throw new Error(`Model assignment for ${role} references unknown profile ${key}`);
  if (!keys.has(cfg.models.default)) throw new Error(`Default model profile ${cfg.models.default} is not defined`);
  return cfg;
}

export const STARTER_CONFIG = `# The AI Company — customer configuration.
# You bring the infrastructure: database, model providers/keys, and code hosting.
# Secrets are referenced by environment variable name only.
company:
  name: Acme Inc

# Local embedded Postgres for evaluation. For production point at your own Postgres:
#   database: { url_env: DATABASE_URL }
database:
  local_path: .aic/db

models:
  profiles:
    # Deterministic offline model used for demos and tests (no network calls, no cost).
    - key: scripted
      provider: scripted
      model: scripted-v1
      family: scripted
    # Example: your own OpenAI-compatible endpoint (OpenAI, Azure OpenAI, vLLM, Ollama, ...).
    # - key: primary
    #   provider: openai_compatible
    #   base_url: https://api.openai.com/v1
    #   model: your-model-name
    #   api_key_env: OPENAI_API_KEY
    #   family: openai
    #   price_per_million: { input: 0, output: 0 }
    # - key: reviewer
    #   provider: anthropic
    #   model: your-model-name
    #   api_key_env: ANTHROPIC_API_KEY
    #   family: anthropic
  default: scripted
  assignments: {}
  # assignments: { code_reviewer: reviewer }   # reviewers on a different model family

code_hosting:
  kind: local
  path: .aic/repo
  # kind: github
  # repo: your-org/your-repo
  # token_env: GITHUB_TOKEN

defaults:
  mode: M4            # Plan Gates: the CEO approves plans before execution
  project_settings:
    test_command: npm test
`;
