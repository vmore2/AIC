// Provider presets for the dashboard's "Add a model provider" flow. They only pre-fill the form:
// the CEO's own key, chosen models and confirmed prices are what get saved. Prices are list prices
// per 1M tokens as last checked (PRICES_CHECKED); providers change them, so the form asks the CEO
// to confirm against the provider's pricing page.
export const PRICES_CHECKED = '2026-10';

export interface ModelPreset { model: string; label: string; input: number | null; output: number | null; context: number; note?: string }
export interface ProviderPreset {
  kind: 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'groq' | 'ollama' | 'custom';
  name: string;
  api: 'openai_compatible' | 'anthropic';
  base_url?: string;
  /** Model family for reviewer independence: reviewers should run on a different family than producers. */
  family: string;
  needs_key: boolean;
  key_hint: string;
  pricing_url?: string;
  models: ModelPreset[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    kind: 'openai', name: 'OpenAI', api: 'openai_compatible', base_url: 'https://api.openai.com/v1', family: 'openai', needs_key: true,
    key_hint: 'platform.openai.com → API keys (starts with sk-)', pricing_url: 'https://openai.com/api/pricing',
    models: [
      { model: 'gpt-4.1-nano', label: 'GPT-4.1 nano — cheapest', input: 0.10, output: 0.40, context: 1_000_000 },
      { model: 'gpt-4.1-mini', label: 'GPT-4.1 mini — balanced', input: 0.40, output: 1.60, context: 1_000_000 },
      { model: 'gpt-4.1', label: 'GPT-4.1 — strongest of the 4.1 line', input: 2.00, output: 8.00, context: 1_000_000 },
      { model: 'gpt-4o-mini', label: 'GPT-4o mini', input: 0.15, output: 0.60, context: 128_000 },
    ],
  },
  {
    kind: 'anthropic', name: 'Anthropic (Claude)', api: 'anthropic', family: 'anthropic', needs_key: true,
    key_hint: 'platform.claude.com → API keys (starts with sk-ant-)', pricing_url: 'https://www.anthropic.com/pricing',
    models: [
      { model: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 — fast and cheap', input: 0.10, output: 0.50, context: 1_000_000, note: 'price for prompts up to 100K tokens' },
      { model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 — everyday work', input: 2.00, output: 10.00, context: 1_000_000 },
      { model: 'claude-opus-5-5', label: 'Claude Opus 5.5 — most capable Opus', input: 4.00, output: 20.00, context: 1_000_000 },
      { model: 'claude-fable-5-1', label: 'Claude Fable 5.1 — hardest problems', input: 10.00, output: 50.00, context: 1_000_000 },
    ],
  },
  {
    kind: 'gemini', name: 'Google Gemini', api: 'openai_compatible', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', family: 'google', needs_key: true,
    key_hint: 'aistudio.google.com → Get API key', pricing_url: 'https://ai.google.dev/pricing',
    models: [
      { model: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite — cheapest', input: 0.10, output: 0.40, context: 1_000_000 },
      { model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', input: 0.30, output: 2.50, context: 1_000_000 },
      { model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', input: 1.25, output: 10.00, context: 1_000_000, note: 'price for prompts up to 200K tokens' },
    ],
  },
  {
    kind: 'openrouter', name: 'OpenRouter (many vendors)', api: 'openai_compatible', base_url: 'https://openrouter.ai/api/v1', family: 'openrouter', needs_key: true,
    key_hint: 'openrouter.ai → Keys', pricing_url: 'https://openrouter.ai/models', models: [],
  },
  {
    kind: 'groq', name: 'Groq', api: 'openai_compatible', base_url: 'https://api.groq.com/openai/v1', family: 'groq', needs_key: true,
    key_hint: 'console.groq.com → API Keys', pricing_url: 'https://groq.com/pricing', models: [],
  },
  {
    kind: 'ollama', name: 'Ollama (models on your own machine)', api: 'openai_compatible', base_url: 'http://localhost:11434/v1', family: 'local', needs_key: false,
    key_hint: 'No key needed; run `ollama serve` and pull a model', models: [],
  },
  {
    kind: 'custom', name: 'Other OpenAI-compatible endpoint', api: 'openai_compatible', family: 'custom', needs_key: true,
    key_hint: 'Azure OpenAI, vLLM, LM Studio, Together, Fireworks…', models: [],
  },
];
