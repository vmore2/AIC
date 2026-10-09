import type { Config, ModelProfile } from '../config/config.js';
import { AnthropicModel, OpenAICompatibleModel, type ModelPort } from './modelPort.js';
import { ScriptedModel, type Persona } from './scripted.js';

/** Builds the customer's configured model for an employee run. */
export class ModelFactory {
  constructor(private readonly profiles: ModelProfile[]) {}
  static fromConfig(cfg: Config) { return new ModelFactory(cfg.models.profiles); }

  profile(key: string): ModelProfile {
    const p = this.profiles.find((x) => x.key === key);
    if (!p) throw new Error(`Model profile "${key}" is not configured`);
    return p;
  }

  create(profileKey: string, persona: Persona): ModelPort {
    const p = this.profile(profileKey);
    switch (p.provider) {
      case 'openai_compatible': return new OpenAICompatibleModel(p);
      case 'anthropic': return new AnthropicModel(p);
      case 'scripted': return new ScriptedModel(p, persona);
    }
  }
}

/** Role profile assignment: explicit mapping, else the default profile. */
export function profileForRole(cfg: Config, roleKey: string): ModelProfile {
  const key = cfg.models.assignments[roleKey] ?? cfg.models.default;
  return cfg.models.profiles.find((p) => p.key === key)!;
}
