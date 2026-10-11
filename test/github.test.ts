import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubApi, GitHubError } from '../src/execution/github.js';

type Call = { method: string; url: string; body: unknown };
function mockGitHub(handler: (c: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const c = { method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    const r = handler(c);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  }));
  return calls;
}
const pr = (n: number, sha: string) => ({ number: n, html_url: `https://github.com/acme/app/pull/${n}`, head: { sha, ref: 'aic/obj/integration' }, state: 'open' });

describe('GitHub release connector (simulated GitHub; no network)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const gh = new GitHubApi('acme/app', 'ghp_test');

  it('creates the release PR when none exists, with auth and API version headers', async () => {
    const calls = mockGitHub((c) => (c.method === 'GET' ? { status: 200, body: [] } : { status: 201, body: pr(7, 'abc') }));
    const r = await gh.ensurePullRequest('aic/obj/integration', 'main', 'Release: X', 'body');
    expect(r.number).toBe(7);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/app/pulls?state=open&head=acme%3Aaic%2Fobj%2Fintegration');
    expect(calls[1]).toMatchObject({ method: 'POST', body: { head: 'aic/obj/integration', base: 'main', title: 'Release: X' } });
  });

  it('is idempotent: reuses an existing open PR instead of opening a duplicate', async () => {
    const calls = mockGitHub(() => ({ status: 200, body: [pr(3, 'abc')] }));
    expect((await gh.ensurePullRequest('aic/obj/integration', 'main', 't', 'b')).number).toBe(3);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('reconciles a create race (422) by finding the PR that won', async () => {
    let lists = 0;
    mockGitHub((c) => (c.method === 'GET' ? { status: 200, body: lists++ === 0 ? [] : [pr(9, 'abc')] } : { status: 422, body: { message: 'A pull request already exists' } }));
    expect((await gh.ensurePullRequest('aic/obj/integration', 'main', 't', 'b')).number).toBe(9);
  });

  it('merges pinned to the approved commit; GitHub refuses if the head moved or protection fails', async () => {
    const calls = mockGitHub((c) => (c.body && (c.body as { sha: string }).sha === 'approved' ? { status: 200, body: { sha: 'merge1', merged: true } } : { status: 409, body: { message: 'Head branch was modified' } }));
    expect(await gh.mergePinned(7, 'approved', 'Release')).toEqual({ sha: 'merge1', merged: true });
    expect(calls[0]).toMatchObject({ method: 'PUT', url: 'https://api.github.com/repos/acme/app/pulls/7/merge', body: { sha: 'approved', merge_method: 'merge' } });
    await expect(gh.mergePinned(7, 'stale', 'Release')).rejects.toBeInstanceOf(GitHubError);
  });
});

describe('GitHub credentials never leak into clones, errors, or agent-readable files', () => {
  const SECRET = 'github_pat_11ABCDEFG0123456789_leakcanary';
  it('keeps the token out of the remote URL and passes it only as a per-command header', async () => {
    const { GitHubCodeHost } = await import('../src/execution/codeHost.js');
    process.env['LEAK_TEST_TOKEN'] = SECRET;
    const host = new GitHubCodeHost('acme/app', 'LEAK_TEST_TOKEN');
    expect(host.remote()).toBe('https://github.com/acme/app.git');
    const env = host.gitEnv();
    expect(env).toMatchObject({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader' });
    expect(Buffer.from(env['GIT_CONFIG_VALUE_0']!.split(' ').pop()!, 'base64').toString()).toBe(`x-access-token:${SECRET}`);
    delete process.env['LEAK_TEST_TOKEN'];
  });

  it('scrubs credentials from git failures (command lines and stderr)', async () => {
    const { git, redactSecrets } = await import('../src/execution/codeHost.js');
    expect(redactSecrets(`git ls-remote https://x-access-token:${SECRET}@github.com/a/b.git`)).toBe('git ls-remote https://***@github.com/a/b.git');
    expect(redactSecrets(`token ${SECRET} and ghp_abcDEF123`)).toBe('token github_pat_*** and ghp_***');
    expect(redactSecrets('AUTHORIZATION: basic eC1hY2Nlc3M=')).toBe('AUTHORIZATION: basic ***');
    const err = await git(process.cwd(), ['ls-remote', `https://x-access-token:${SECRET}@127.0.0.1:9/nope.git`]).catch((e: Error & { stderr: string }) => e);
    expect(err).toBeInstanceOf(Error);
    expect(`${(err as Error).message} ${(err as Error & { stderr: string }).stderr}`).not.toContain(SECRET);
  }, 30_000);
});
