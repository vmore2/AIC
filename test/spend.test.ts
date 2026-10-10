import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ModelProfile } from '../src/config/config.js';
import type { ModelPort, ModelRequest, ModelResponse } from '../src/runtime/modelPort.js';
import { SpendGuard, SpendGuardedModel } from '../src/runtime/spendGuard.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-spend-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const profile: ModelProfile = { key: 'cheap', provider: 'openai_compatible', model: 'gpt-4.1-nano', family: 'openai', api_key_env: 'SPEND_TEST_KEY',
  context_tokens: 100000, structured_output: true, tool_calling: true, price_per_million: { input: 0.1, output: 0.4 } };

class FakeModel implements ModelPort {
  calls = 0;
  constructor(readonly profile: ModelProfile, private readonly usage = { inputTokens: 1_000_000, outputTokens: 0 }) {}
  async generate(_r: ModelRequest): Promise<ModelResponse> { this.calls++; return { text: 'x', toolCalls: [], usage: this.usage }; }
}
const req: ModelRequest = { system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], maxOutputTokens: 1000 };

describe('lifetime spend cap (no network)', () => {
  it('records actual cost per key (never the key itself) and refuses calls that could exceed the cap', async () => {
    process.env['SPEND_TEST_KEY'] = 'sk-secret-value';
    const file = path.join(dir, 'ledger.json');
    const guard = new SpendGuard(file, 0.001);
    const inner = new FakeModel(profile, { inputTokens: 100, outputTokens: 1000 }); // each call: $0.00041
    const m = new SpendGuardedModel(inner, guard);
    await m.generate(req);
    await m.generate(req);
    expect(guard.spent(SpendGuard.keyId(profile))).toBeCloseTo(0.00082, 8);
    await expect(m.generate(req)).rejects.toThrow(/Spend cap reached/); // worst case (max output) would exceed the cap
    expect(inner.calls).toBe(2); // the third call never reached the provider
    expect(readFileSync(file, 'utf8')).not.toContain('sk-secret-value');
    // A new guard instance (another process / test run) sees the same lifetime total.
    expect(new SpendGuard(file, 0.001).spent(SpendGuard.keyId(profile))).toBeCloseTo(0.00082, 8);
    delete process.env['SPEND_TEST_KEY'];
  });

  it('refuses real calls when prices are missing (the cap could not be enforced)', async () => {
    const m = new SpendGuardedModel(new FakeModel({ ...profile, price_per_million: { input: 0, output: 0 } }), new SpendGuard(path.join(dir, 'l2.json'), 5));
    await expect(m.generate(req)).rejects.toThrow(/no prices/);
  });
});
