import { ModelProfileSchema, type Config, type ModelProfile } from '../config/config.js';
import type { Queryable } from '../ledger/db.js';
import type { SecretVault } from '../secrets/vault.js';
import { AnthropicModel, OpenAICompatibleModel, type ModelPort, type SecretLookup } from './modelPort.js';
import { ScriptedModel, type Persona } from './scripted.js';
import { SpendGuard, SpendGuardedModel } from './spendGuard.js';

/**
 * The customer's models: profiles from aic.config.yaml plus the ones the CEO added in the dashboard
 * (model_profiles table, keys in the vault). Builds the model for an employee run.
 */
export class ModelFactory {
  private added: ModelProfile[] = [];
  constructor(private readonly configured: ModelProfile[], private readonly guard: SpendGuard | null = null, private readonly vault?: SecretVault) {}
  static fromConfig(cfg: Config, vault?: SecretVault) { return new ModelFactory(cfg.models.profiles, null, vault); }

  get profiles(): ModelProfile[] { return [...this.configured, ...this.added]; }

  /** Reload dashboard-managed profiles (call after any change). */
  async refresh(db: Queryable) {
    const rows = await db.query<{ profile: unknown }>(`SELECT profile FROM model_profiles WHERE status = 'active' ORDER BY created_at`);
    this.added = rows.rows.map((r) => ModelProfileSchema.parse(r.profile)).filter((p) => !this.configured.some((c) => c.key === p.key));
  }

  profile(key: string): ModelProfile {
    const p = this.profiles.find((x) => x.key === key);
    if (!p) throw new Error(`Model profile "${key}" is not configured`);
    return p;
  }

  get secretLookup(): SecretLookup | undefined { return this.vault ? (id) => this.vault!.get<string>(id) : undefined; }

  create(profileKey: string, persona: Persona): ModelPort {
    const p = this.profile(profileKey);
    if (p.provider === 'scripted') return new ScriptedModel(p, persona);
    const inner = p.provider === 'openai_compatible' ? new OpenAICompatibleModel(p, this.secretLookup) : new AnthropicModel(p, this.secretLookup);
    // Real providers go through the lifetime spend cap when one is configured (AIC_SPEND_CAP_USD).
    const guard = this.guard ?? SpendGuard.fromEnv();
    return guard ? new SpendGuardedModel(inner, guard, this.secretLookup) : inner;
  }
}

/**
 * Model for a role when hiring: an explicit choice, else the company default the CEO picked in the
 * dashboard, else the config's assignment/default.
 */
export function profileForRole(cfg: Config, roleKey: string, models?: ModelFactory, choice?: { explicit?: string; companyDefault?: string }): ModelProfile {
  const all = models?.profiles ?? cfg.models.profiles;
  const key = choice?.explicit ?? cfg.models.assignments[roleKey] ?? choice?.companyDefault ?? cfg.models.default;
  const p = all.find((x) => x.key === key) ?? all.find((x) => x.key === cfg.models.default);
  if (!p) throw new Error(`Model profile "${key}" is not configured`);
  return p;
}
