import type { Config, ModelProfile } from '../config/config.js';
import { AnthropicModel, OpenAICompatibleModel, type ModelPort } from './modelPort.js';
import { ScriptedModel, type Persona } from './scripted.js';
import { SpendGuard, SpendGuardedModel } from './spendGuard.js';

/** Builds the customer's configured model for an employee run. */
export class ModelFactory {
  constructor(private readonly profiles: ModelProfile[], private readonly guard: SpendGuard | null = null) {}
  static fromConfig(cfg: Config) { return new ModelFactory(cfg.models.profiles); }

  profile(key: string): ModelProfile {
    const p = this.profiles.find((x) => x.key === key);
    if (!p) throw new Error(`Model profile "${key}" is not configured`);
    return p;
  }

  create(profileKey: string, persona: Persona): ModelPort {
    const p = this.profile(profileKey);
    if (p.provider === 'scripted') return new ScriptedModel(p, persona);
    const inner = p.provider === 'openai_compatible' ? new OpenAICompatibleModel(p) : new AnthropicModel(p);
    // Real providers go through the lifetime spend cap when one is configured (AIC_SPEND_CAP_USD).
    const guard = this.guard ?? SpendGuard.fromEnv();
    return guard ? new SpendGuardedModel(inner, guard) : inner;
  }
}

/** Role profile assignment: explicit mapping, else the default profile. */
export function profileForRole(cfg: Config, roleKey: string): ModelProfile {
  const key = cfg.models.assignments[roleKey] ?? cfg.models.default;
  return cfg.models.profiles.find((p) => p.key === key)!;
}
