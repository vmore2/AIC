// Customer configuration. The AI Company hosts nothing: each company supplies its own
// database, model providers and keys, and code hosting. Secrets are referenced by
// environment-variable name and never stored in config files or the ledger.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { MODES } from '../domain/types.js';

/**
 * The NAME of an environment variable (e.g. GITHUB_TOKEN), never the secret itself. A pasted token would
 * otherwise be looked up as a variable name, fail, and be echoed in the "is not set" error.
 */
const SECRET_SHAPE = /^(github_pat_|gh[pousr]_|sk-|sk_|xox[abpr]-|AIza|GOCSPX-|glpat-)/;
export const EnvVarName = z.string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be the name of an environment variable (letters, digits, underscores), e.g. GITHUB_TOKEN — put the value itself in .env')
  .refine((v) => !SECRET_SHAPE.test(v) && v.length <= 64, 'looks like a secret value, not a variable name: put the secret in .env (e.g. GITHUB_TOKEN=...) and write only the variable name here');

export const ModelProfileSchema = z.object({
  key: z.string(),
  provider: z.enum(['openai_compatible', 'anthropic', 'scripted']),
  model: z.string(),
  base_url: z.string().url().optional(),
  api_key_env: EnvVarName.optional(),
  /** Vault id of a key the CEO entered in the dashboard (alternative to api_key_env). */
  api_key_secret: z.string().optional(),
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
    z.object({ url_env: EnvVarName }),
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
    z.object({ kind: z.literal('github'), repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'must be owner/name, e.g. your-org/your-repo'), token_env: EnvVarName, base_branch: z.string().default('main'), api_url: z.string().url().default('https://api.github.com') }),
  ]).default({ kind: 'local', path: '.aic/repo' }),
  defaults: z.object({
    mode: z.enum(MODES).default('M4'),
    project_settings: z.record(z.string()).default({ test_command: 'npm test' }),
  }).default({}),
  /**
   * Sandbox for agent-executed commands. Production must use an isolated sandbox (microVM/gVisor).
   * `allow_unisolated_local` permits a plain local subprocess for evaluation on a trusted machine only.
   */
  sandbox: z.object({
    kind: z.enum(['local', 'docker']).default('local'),
    allow_unisolated_local: z.boolean().default(false),
    docker: z.object({
      image: z.string().default('node:22-bookworm-slim'),
      memory: z.string().default('2g'),
      cpus: z.number().positive().default(2),
      pids: z.number().int().positive().default(512),
      network: z.enum(['none', 'bridge']).default('none'),
    }).default({}),
  }).default({}),
  /** Where run workspaces and transcripts are stored (customer storage). */
  storage_path: z.string().default('.aic/storage'),
  /** The company's own custom teams (recommended teams ship with the platform). */
  teams_path: z.string().default('teams'),
  /** Extra Cedar policies (baseline forbids cannot be weakened). */
  policies_path: z.string().default('policies'),
  /**
   * Dashboard sign-in. Access tokens always work; Google sign-in is optional and uses the CEO's own
   * OAuth client (Google Cloud console → Credentials → OAuth client ID → Web application).
   */
  auth: z.object({
    google: z.object({
      client_id: z.string().min(10),
      client_secret_env: EnvVarName.default('GOOGLE_CLIENT_SECRET'),
      /** Must match the authorized redirect URI: <public_url>/auth/google/callback */
      public_url: z.string().url().default('http://localhost:4100'),
      allowed_domain: z.string().optional(),
    }).optional(),
    session_secret_env: EnvVarName.default('AIC_SESSION_SECRET'),
  }).default({}),
  /** Encrypts the secret vault (keys and passwords entered in the dashboard); generated into storage if unset. */
  master_key_env: EnvVarName.default('AIC_MASTER_KEY'),
  /** Signs run credentials; supply via env in production. */
  credential_secret_env: EnvVarName.default('AIC_CREDENTIAL_SECRET'),
});
export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG_FILE = 'aic.config.yaml';

export function loadConfig(file = DEFAULT_CONFIG_FILE, baseDir = process.cwd()): Config {
  const full = path.resolve(baseDir, file);
  if (!existsSync(full)) throw new Error(`Config not found at ${full}. Run \`aic init\` to create one.`);
  let raw: unknown;
  try { raw = parseYaml(readFileSync(full, 'utf8')); } catch (e) { throw new Error(`${full} is not valid YAML: ${(e as Error).message}`); }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${full} has problems:\n${parsed.error.issues.map((i) => `   - ${i.path.join('.') || '(top level)'}: ${i.message}`).join('\n')}`);
  const cfg = parsed.data;
  const base = path.dirname(full);
  const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(base, p));
  if ('local_path' in cfg.database) cfg.database = { local_path: abs(cfg.database.local_path) };
  if (cfg.code_hosting.kind === 'local') cfg.code_hosting = { ...cfg.code_hosting, path: abs(cfg.code_hosting.path) };
  cfg.storage_path = abs(cfg.storage_path);
  cfg.teams_path = abs(cfg.teams_path);
  cfg.policies_path = abs(cfg.policies_path);
  const keys = new Set(cfg.models.profiles.map((p) => p.key));
  for (const [role, key] of Object.entries(cfg.models.assignments)) if (!keys.has(key)) throw new Error(`Model assignment for ${role} references unknown profile ${key}`);
  if (!keys.has(cfg.models.default)) throw new Error(`Default model profile ${cfg.models.default} is not defined`);
  return cfg;
}

export const STARTER_CONFIG = `# The AI Company — customer configuration.
# You bring the infrastructure: database, model providers/keys, and code hosting.
# Secrets are referenced by environment variable NAME only. Put the values in a .env file next to this
# one (the platform repository has .env.example listing every variable). Check your setup: aic doctor
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
    test_command: node --test

# Where agent-run commands (tests, builds) execute.
#   kind: docker  → each command in a locked-down container on YOUR Docker (no network, no
#                   capabilities, read-only root, resource limits). Recommended.
#   kind: local   → plain local processes. NOT isolated; evaluation on a trusted machine only.
sandbox:
  kind: local
  allow_unisolated_local: true
  # kind: docker
  # docker: { image: node:22-bookworm-slim, memory: 2g, cpus: 2, network: none }

# Dashboard sign-in. Access tokens always work. To let people sign in with Google, create an OAuth
# client (Web application) in YOUR Google Cloud project, add the redirect URI
# http://localhost:4100/auth/google/callback, put the secret in .env as GOOGLE_CLIENT_SECRET, and
# give each person an email: aic users email ceo you@example.com
# auth:
#   google:
#     client_id: 1234-abc.apps.googleusercontent.com
#     public_url: http://localhost:4100
#     allowed_domain: example.com      # optional: only accounts from this Google Workspace domain
`;
