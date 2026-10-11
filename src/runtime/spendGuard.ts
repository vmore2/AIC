// Lifetime spend cap for real model providers. A small ledger file OUTSIDE any company folder
// (default ~/.aic/spend-ledger.json) accumulates every real call's cost per API key, across all
// companies, test runs, and processes. Before each call the worst-case cost is checked against
// the cap; if it could exceed it, the call is refused (non-retryable).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelProfile } from '../config/config.js';
import { apiKey, costOf, estimateTokens, ProviderError, type ModelPort, type ModelRequest, type ModelResponse, type SecretLookup } from './modelPort.js';

interface LedgerFile { version: 1; keys: Record<string, { spent_usd: number; calls: number; entries: { at: string; model: string; input: number; output: number; usd: number }[] }> }

export class SpendGuard {
  constructor(readonly file: string, readonly capUsd: number) {}

  static fromEnv(): SpendGuard | null {
    const cap = Number(process.env['AIC_SPEND_CAP_USD']);
    if (!Number.isFinite(cap) || cap <= 0) return null;
    return new SpendGuard(process.env['AIC_SPEND_LEDGER'] ?? path.join(os.homedir(), '.aic', 'spend-ledger.json'), cap);
  }

  private read(): LedgerFile {
    if (!existsSync(this.file)) return { version: 1, keys: {} };
    return JSON.parse(readFileSync(this.file, 'utf8')) as LedgerFile;
  }
  private write(l: LedgerFile) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(l, null, 1));
    renameSync(tmp, this.file);
  }

  /** Fingerprint of the API key (never the key itself). */
  static keyId(profile: ModelProfile, secret?: SecretLookup): string {
    let key = '';
    try { key = apiKey(profile, secret); } catch { /* unknown key: counted under the empty-key bucket */ }
    return `${profile.provider}:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
  }

  spent(keyId: string): number { return this.read().keys[keyId]?.spent_usd ?? 0; }

  assertAllowed(keyId: string, worstCaseUsd: number) {
    const spent = this.spent(keyId);
    if (spent + worstCaseUsd > this.capUsd)
      throw new ProviderError(`Spend cap reached: $${spent.toFixed(4)} of $${this.capUsd.toFixed(2)} used; this call could cost up to $${worstCaseUsd.toFixed(4)}. Raise AIC_SPEND_CAP_USD deliberately to continue.`, false);
  }

  record(keyId: string, model: string, input: number, output: number, usd: number) {
    const l = this.read();
    const k = (l.keys[keyId] ??= { spent_usd: 0, calls: 0, entries: [] });
    k.spent_usd = Math.round((k.spent_usd + usd) * 1e8) / 1e8;
    k.calls += 1;
    k.entries.push({ at: new Date().toISOString(), model, input, output, usd: Math.round(usd * 1e8) / 1e8 });
    if (k.entries.length > 5000) k.entries = k.entries.slice(-5000);
    this.write(l);
  }
}

/** Wraps a real provider: worst-case pre-check against the lifetime cap, then records actual usage. */
export class SpendGuardedModel implements ModelPort {
  constructor(private readonly inner: ModelPort, private readonly guard: SpendGuard, private readonly secret?: SecretLookup) {}
  get profile() { return this.inner.profile; }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const p = this.inner.profile;
    // Keyless endpoints (e.g. Ollama on the CEO's machine) are free to run; paid keys need prices to be capped.
    const keyed = !!(p.api_key_env || p.api_key_secret);
    if (keyed && (p.price_per_million.input <= 0 || p.price_per_million.output <= 0))
      throw new ProviderError(`Model profile ${p.key} has no prices; the spend cap cannot be enforced, so the call is refused`, false);
    const keyId = SpendGuard.keyId(p, this.secret);
    const maxOut = req.maxOutputTokens ?? 4096;
    const inputEst = estimateTokens(req.system + JSON.stringify(req.messages) + JSON.stringify(req.tools)) * 1.3;
    this.guard.assertAllowed(keyId, costOf(p, { inputTokens: inputEst, outputTokens: maxOut }));
    const res = await this.inner.generate({ ...req, maxOutputTokens: maxOut });
    this.guard.record(keyId, p.model, res.usage.inputTokens, res.usage.outputTokens, costOf(p, res.usage));
    return res;
  }
}
