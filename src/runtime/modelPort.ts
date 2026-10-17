// Model port (architecture.md §6.9). Customers bring their own providers and keys;
// the platform never ships or pays for model access.
import type { ModelProfile } from '../config/config.js';

export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

export interface ModelRequest { system: string; messages: ChatMessage[]; tools: ToolSpec[]; maxOutputTokens?: number }
export interface ModelResponse { text: string; toolCalls: ToolCall[]; usage: { inputTokens: number; outputTokens: number } }

export interface ModelPort { readonly profile: ModelProfile; generate(req: ModelRequest): Promise<ModelResponse> }

export class ProviderError extends Error {
  constructor(message: string, public readonly retryable: boolean, public readonly status?: number) { super(message); }
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export function costOf(profile: ModelProfile, usage: { inputTokens: number; outputTokens: number }): number {
  return (usage.inputTokens * profile.price_per_million.input + usage.outputTokens * profile.price_per_million.output) / 1_000_000;
}

/** Reads a secret from the customer's vault (keys the CEO entered in the dashboard). */
export type SecretLookup = (id: string) => string;

export function apiKey(profile: ModelProfile, secret?: SecretLookup): string {
  if (profile.api_key_secret) {
    if (!secret) throw new ProviderError(`Model profile ${profile.key} uses a vault key but no vault is available`, false);
    return secret(profile.api_key_secret);
  }
  if (!profile.api_key_env) return ''; // keyless endpoint (e.g. Ollama on the CEO's machine)
  const k = process.env[profile.api_key_env];
  if (!k) throw new ProviderError(`Environment variable ${profile.api_key_env} is not set for model profile ${profile.key} (add it to .env)`, false);
  return k;
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 120_000): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new ProviderError(`Provider returned ${res.status}: ${text.slice(0, 300)}`, res.status === 429 || res.status >= 500, res.status);
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(`Provider request failed: ${(e as Error).message}`, true);
  } finally {
    clearTimeout(timer);
  }
}

/** Any OpenAI-compatible chat-completions endpoint (OpenAI, Azure OpenAI, vLLM, Ollama, LM Studio, …). */
export class OpenAICompatibleModel implements ModelPort {
  constructor(readonly profile: ModelProfile, private readonly secret?: SecretLookup) {}
  async generate(req: ModelRequest): Promise<ModelResponse> {
    const base = (this.profile.base_url ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const messages = [{ role: 'system', content: req.system }, ...req.messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      if (m.role === 'assistant') return { role: 'assistant', content: m.content || null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments) } })) } : {}) };
      return m;
    })];
    const body = {
      model: this.profile.model, messages,
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
      ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
    };
    const r = await post(`${base}/chat/completions`, { authorization: `Bearer ${apiKey(this.profile, this.secret)}` }, body) as {
      choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    const msg = r.choices[0]?.message;
    return {
      text: msg?.content ?? '',
      toolCalls: (msg?.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, arguments: safeJson(t.function.arguments) })),
      usage: { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0 },
    };
  }
}

/** Anthropic Messages API. */
export class AnthropicModel implements ModelPort {
  constructor(readonly profile: ModelProfile, private readonly secret?: SecretLookup) {}
  async generate(req: ModelRequest): Promise<ModelResponse> {
    const base = (this.profile.base_url ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const messages: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
    const push = (role: 'user' | 'assistant', block: unknown) => {
      const last = messages.at(-1);
      if (last && last.role === role) last.content.push(block); else messages.push({ role, content: [block] });
    };
    for (const m of req.messages) {
      if (m.role === 'user') push('user', { type: 'text', text: m.content });
      else if (m.role === 'tool') push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
      else {
        if (m.content) push('assistant', { type: 'text', text: m.content });
        for (const t of m.toolCalls ?? []) push('assistant', { type: 'tool_use', id: t.id, name: t.name, input: t.arguments });
      }
    }
    const r = await post(`${base}/v1/messages`, { 'x-api-key': apiKey(this.profile, this.secret), 'anthropic-version': '2023-06-01' }, {
      model: this.profile.model, system: req.system, messages, max_tokens: req.maxOutputTokens ?? 4096,
      ...(req.tools.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
    }) as { content: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> })[]; usage: { input_tokens: number; output_tokens: number } };
    return {
      text: r.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join('\n'),
      toolCalls: r.content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, arguments: b.input })),
      usage: { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens },
    };
  }
}

/**
 * Checks a key without spending money: lists the provider's models (a free endpoint on OpenAI-compatible
 * APIs and Anthropic). Returns the model ids the key can see.
 */
export async function listProviderModels(provider: 'openai_compatible' | 'anthropic', baseUrl: string | undefined, key: string): Promise<string[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const url = provider === 'anthropic' ? `${(baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/models?limit=100`
      : `${(baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/models`;
    const headers: Record<string, string> = provider === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` };
    const res = await fetch(url, { headers, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) throw new ProviderError(res.status === 401 || res.status === 403 ? 'The provider rejected this key' : `Provider returned ${res.status}: ${text.slice(0, 200)}`, false, res.status);
    const body = JSON.parse(text) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id).sort();
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(`Could not reach the provider: ${(e as Error).message}`, true);
  } finally { clearTimeout(timer); }
}

function safeJson(s: string): Record<string, unknown> {
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : { _raw: s }; } catch { return { _raw: s }; }
}
