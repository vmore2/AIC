import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { ConfigSchema, type ModelProfile } from '../src/config/config.js';
import { SYSTEM } from '../src/domain/types.js';
import { defaultSandboxUser, DockerSandbox } from '../src/execution/sandbox.js';
import { AnthropicModel, OpenAICompatibleModel, ProviderError } from '../src/runtime/modelPort.js';
import { runDoctor } from '../src/ops/doctor.js';

const dockerUp = (() => { try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }); return true; } catch { return false; } })();

describe('Docker sandbox', () => {
  const sb = new DockerSandbox({ image: 'node:22-bookworm-slim', memory: '2g', cpus: 2, pids: 512, network: 'none' });
  it('runs as the platform user on Linux (so it can use the workspace), never as root', () => {
    expect(defaultSandboxUser('linux', { uid: 1001, gid: 118 })).toBe('1001:118');
    expect(defaultSandboxUser('linux', { uid: 0, gid: 0 })).toBe('1000:1000');
    expect(defaultSandboxUser('win32', { uid: undefined, gid: undefined })).toBe('1000:1000');
    expect(defaultSandboxUser('darwin', { uid: 501, gid: 20 })).toBe('1000:1000');
    expect(new DockerSandbox({ image: 'x', memory: '1g', cpus: 1, pids: 64, network: 'none', user: '2000:2000' }).args('/w', 'true', 'n')).toContain('2000:2000');
  });
  it('runs every agent command with no network, no capabilities, read-only root, non-root user, and limits', () => {
    const a = sb.args('/work/run1', 'npm test', 'aic-sbx-x');
    const pair = (flag: string) => a[a.indexOf(flag) + 1];
    expect(pair('--network')).toBe('none');
    expect(pair('--cap-drop')).toBe('ALL');
    expect(pair('--security-opt')).toBe('no-new-privileges');
    expect(pair('--user')).toBe(defaultSandboxUser());
    expect(pair('--user')).not.toMatch(/^0:/);
    expect(pair('--memory')).toBe('2g');
    expect(pair('--pids-limit')).toBe('512');
    expect(a).toContain('--read-only');
    expect(a).toContain('--rm');
    expect(a.join(' ')).toContain('/work/run1:/workspace:rw');
    expect(a.slice(-3)).toEqual(['sh', '-c', 'npm test']); // command passed as one argument, never shell-interpolated on the host
    expect(a.join(' ')).not.toMatch(/API_KEY|TOKEN/);
  });
  it.skipIf(!dockerUp)('executes in a container without network access (requires Docker)', async () => {
    const r = await sb.exec(os.tmpdir(), 'node -e "fetch(\'https://example.com\').then(()=>console.log(\'NET\')).catch(()=>console.log(\'NO-NET\'))"', 120_000);
    expect(r.stdout).toContain('NO-NET');
  }, 180_000);
});

const profile = (o: Partial<ModelProfile>): ModelProfile => ({ key: 'p', provider: 'openai_compatible', model: 'm', family: 'f', context_tokens: 1000, structured_output: true, tool_calling: true, price_per_million: { input: 0, output: 0 }, api_key_env: 'TEST_KEY', ...o });

describe('model adapters (customer-provided providers; no real network calls)', () => {
  afterEach(() => { vi.unstubAllGlobals(); delete process.env['TEST_KEY']; });

  it('OpenAI-compatible: sends tools and history in the chat-completions shape and parses tool calls', async () => {
    process.env['TEST_KEY'] = 'sk-test';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'fs__write', arguments: '{"path":"a.md","content":"x"}' } }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 5 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const m = new OpenAICompatibleModel(profile({ base_url: 'http://localhost:8000/v1' }));
    const r = await m.generate({ system: 'sys', tools: [{ name: 'fs__write', description: 'd', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c0', name: 'fs__read', arguments: { path: 'a' } }] }, { role: 'tool', toolCallId: 'c0', name: 'fs__read', content: 'data' }] });
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'fs__write', arguments: { path: 'a.md', content: 'x' } }]);
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/v1/chat/completions');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body));
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(body.messages[2].tool_calls[0].function).toEqual({ name: 'fs__read', arguments: '{"path":"a"}' });
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'c0', content: 'data' });
    expect(body.tools[0].type).toBe('function');
  });

  it('Anthropic: maps tool use/results to content blocks and parses tool_use', async () => {
    process.env['TEST_KEY'] = 'ak-test';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'ledger__submit_work', input: { summary: 'done' } }],
      usage: { input_tokens: 20, output_tokens: 7 },
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const m = new AnthropicModel(profile({ provider: 'anthropic' }));
    const r = await m.generate({ system: 'sys', tools: [{ name: 'ledger__submit_work', description: 'd', parameters: { type: 'object' } }],
      messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: 'calling', toolCalls: [{ id: 't0', name: 'fs__read', arguments: { path: 'a' } }] }, { role: 'tool', toolCallId: 't0', name: 'fs__read', content: 'data' }] });
    expect(r).toMatchObject({ text: 'ok', toolCalls: [{ id: 't1', name: 'ledger__submit_work', arguments: { summary: 'done' } }], usage: { inputTokens: 20, outputTokens: 7 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('ak-test');
    const body = JSON.parse(String(init.body));
    expect(body.system).toBe('sys');
    expect(body.messages[1].content[1]).toEqual({ type: 'tool_use', id: 't0', name: 'fs__read', input: { path: 'a' } });
    expect(body.messages[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 't0', content: 'data' });
    expect(body.tools[0].input_schema).toEqual({ type: 'object' });
  });

  it('classifies provider failures as retryable (429/5xx) or not (4xx), and refuses missing keys', async () => {
    process.env['TEST_KEY'] = 'k';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    const m = new OpenAICompatibleModel(profile({}));
    await expect(m.generate({ system: '', messages: [], tools: [] })).rejects.toMatchObject({ retryable: true, status: 429 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad', { status: 400 })));
    await expect(m.generate({ system: '', messages: [], tools: [] })).rejects.toMatchObject({ retryable: false });
    delete process.env['TEST_KEY'];
    await expect(m.generate({ system: '', messages: [], tools: [] })).rejects.toBeInstanceOf(ProviderError);
  });
});

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-doc-'));
let app: App;
afterAll(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

describe('aic doctor', () => {
  it('reports evaluation setups honestly and fails on missing provider keys', async () => {
    app = await createApp(ConfigSchema.parse({
      company: { name: 'Doc' }, database: { local_path: path.join(dir, 'db') },
      models: { profiles: [{ key: 'scripted', provider: 'scripted', model: 's', family: 'a' }, { key: 'real', provider: 'openai_compatible', model: 'm', family: 'b', api_key_env: 'AIC_TEST_MISSING_KEY' }], default: 'scripted' },
      code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'), teams_path: path.join(dir, 'teams'),
      sandbox: { allow_unisolated_local: true },
    }));
    await app.ledger.run('bootstrapCompany', { companyName: 'Doc', ceoName: 'C', defaultMode: 'M4' }, SYSTEM);
    const r = await runDoctor(app);
    const by = (n: string) => r.find((x) => x.check === n)!;
    expect(by('Database').level).toBe('warn');
    expect(by('Ledger integrity').level).toBe('pass');
    expect(by('Model: real').level).toBe('fail');
    expect(by('Sandbox').level).toBe('warn');
    expect(by('Code hosting').level).toBe('pass');
    expect(by('Team catalog').level).toBe('pass');
  }, 60_000);
});
