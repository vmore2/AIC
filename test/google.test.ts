// Google sign-in against a mock Google (no network): authorization code + PKCE, nonce, allowed users,
// signed sessions, CSRF header for cookie writes, and step-up for governance.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { GoogleAuth } from '../src/api/auth.js';
import { buildServer } from '../src/api/server.js';
import { ConfigSchema } from '../src/config/config.js';
import { SYSTEM, type Principal } from '../src/domain/types.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'aic-google-'));
let app: App;
let google: Server;
afterAll(async () => { google?.close(); await app?.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** What the mock Google will put in the next ID token (the test plays the user at Google's consent screen). */
let next: { email: string; nonce: string; challenge: string; overrides?: Record<string, unknown> };

async function mockGoogle(): Promise<string> {
  google = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const f = new URLSearchParams(body);
      const pkceOk = createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') === next.challenge;
      if (req.url !== '/token' || f.get('code') !== 'good-code' || f.get('client_id') !== CLIENT_ID || f.get('client_secret') !== 'shh' || !pkceOk) {
        res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_grant"}');
        return;
      }
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1234', email: next.email, email_verified: true, nonce: next.nonce, iat: now, exp: now + 3600, auth_time: now, ...next.overrides };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id_token: `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`, access_token: 'x' }));
    });
  });
  await new Promise<void>((r) => google.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(google.address() as AddressInfo).port}`;
}

const cookieFrom = (setCookie: string | string[] | undefined, name: string) =>
  ([] as string[]).concat(setCookie ?? []).map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${name}=`));

describe('Google sign-in (mock Google)', () => {
  it('signs in people the CEO added, rejects everyone else, and requires a fresh sign-in for governance', async () => {
    app = await createApp(ConfigSchema.parse({
      company: { name: 'G' }, database: { local_path: path.join(dir, 'db') },
      models: { profiles: [{ key: 'scripted', provider: 'scripted', model: 's', family: 'a' }], default: 'scripted' },
      code_hosting: { kind: 'local', path: path.join(dir, 'repo.git') }, storage_path: path.join(dir, 'storage'), teams_path: path.join(dir, 'teams'),
    }));
    const b = await app.ledger.run('bootstrapCompany', { companyName: 'G', ceoName: 'Casey', ceoEmail: 'casey@acme.test', defaultMode: 'M4' }, SYSTEM);
    const ceo: Principal = { type: 'user', id: b.ceoUserId, stepUp: true };
    const viewer = await app.ledger.run('addUser', { name: 'Vic', role: 'viewer', email: 'Vic@Acme.test' }, ceo);
    await expect(app.ledger.run('addUser', { name: 'Dup', role: 'viewer', email: 'vic@acme.test' }, ceo)).rejects.toThrow(/already belongs/);

    const base = await mockGoogle();
    const cfg = { clientId: CLIENT_ID, clientSecret: 'shh', publicUrl: 'http://localhost:4100', sessionSecret: 'test-session-secret',
      authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token` };
    const server = buildServer(app, 'owner-token', { google: new GoogleAuth(cfg, app.ledger.db) });
    const host = { host: 'localhost:4100' };

    // Not signed in: the dashboard learns Google sign-in is available.
    expect((await server.inject({ url: '/api/auth/config' })).json()).toEqual({ google: true });
    expect((await server.inject({ url: '/api/me', headers: host })).statusCode).toBe(401);
    // Started on another host → bounced to the public URL first (cookies are per host).
    const bounce = await server.inject({ url: '/auth/google', headers: { host: '127.0.0.1:4100' } });
    expect(bounce.headers.location).toBe('http://localhost:4100/auth/google');

    async function signIn(email: string, overrides?: Record<string, unknown>, query = '') {
      const start = await server.inject({ url: `/auth/google${query}`, headers: host });
      expect(start.statusCode).toBe(302);
      const to = new URL(String(start.headers.location));
      expect(to.origin + to.pathname).toBe(`${base}/authorize`);
      expect(to.searchParams.get('redirect_uri')).toBe('http://localhost:4100/auth/google/callback');
      expect(to.searchParams.get('code_challenge_method')).toBe('S256');
      next = { email, nonce: to.searchParams.get('nonce')!, challenge: to.searchParams.get('code_challenge')!, overrides };
      const flow = cookieFrom(start.headers['set-cookie'], 'aic_oauth')!;
      return { state: to.searchParams.get('state')!, flow, params: to.searchParams,
        callback: (q: string) => server.inject({ url: `/auth/google/callback?${q}`, headers: { ...host, cookie: flow } }) };
    }

    // Tampered state and a forged nonce are refused.
    let s = await signIn('casey@acme.test');
    expect((await s.callback(`code=good-code&state=forged`)).statusCode).toBe(400);
    s = await signIn('casey@acme.test', { nonce: 'replayed' });
    expect((await s.callback(`code=good-code&state=${s.state}`)).statusCode).toBe(401);
    s = await signIn('casey@acme.test', { email_verified: false });
    expect((await s.callback(`code=good-code&state=${s.state}`)).statusCode).toBe(401);
    // A real Google account the CEO never added gets no access.
    s = await signIn('stranger@gmail.com');
    const denied = await s.callback(`code=good-code&state=${s.state}`);
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toMatch(/has no access to this company/);

    // The CEO signs in (fresh sign-in → step-up for governance).
    s = await signIn('casey@acme.test');
    const ok = await s.callback(`code=good-code&state=${s.state}`);
    expect(ok.statusCode).toBe(302);
    const session = cookieFrom(ok.headers['set-cookie'], 'aic_session')!;
    expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Lax/);
    const me = await server.inject({ url: '/api/me', headers: { ...host, cookie: session } });
    expect(me.json()).toMatchObject({ id: b.ceoUserId, name: 'Casey', role: 'ceo', owner: true, auth: 'google' });

    // Cookie writes need the dashboard's header (CSRF); then governance works with a fresh sign-in.
    const stopNoHeader = await server.inject({ method: 'POST', url: '/api/emergency-stop', payload: { reason: 'drill' }, headers: { ...host, cookie: session } });
    expect(stopNoHeader.statusCode).toBe(403);
    const stop = await server.inject({ method: 'POST', url: '/api/emergency-stop', payload: { reason: 'drill' }, headers: { ...host, cookie: session, 'x-requested-with': 'aic' } });
    expect(stop.statusCode).toBe(200);

    // A tampered session cookie is worthless.
    const [body, sig] = session.slice('aic_session='.length).split('.');
    const forged = b64({ ...JSON.parse(Buffer.from(decodeURIComponent(body!), 'base64url').toString()), uid: viewer.userId });
    expect((await server.inject({ url: '/api/me', headers: { ...host, cookie: `aic_session=${forged}.${sig}` } })).statusCode).toBe(401);

    // An older sign-in is not enough for governance: the API points the dashboard at a re-verification.
    const stale = buildServer(app, 'owner-token', { google: new GoogleAuth({ ...cfg, stepUpMinutes: 0 }, app.ledger.db) });
    const resume = await stale.inject({ method: 'POST', url: '/api/resume', payload: { reason: 'back' }, headers: { ...host, cookie: session, 'x-requested-with': 'aic' } });
    expect(resume.statusCode).toBe(403);
    expect(resume.json().step_up_url).toBe('/auth/google?stepup=1');
    const again = await signIn('casey@acme.test', undefined, '?stepup=1');
    expect(again.params.get('max_age')).toBe('0'); // Google must re-authenticate the person

    // The viewer (email matched case-insensitively) signs in with their own, limited role.
    s = await signIn('vic@acme.test');
    const vs = cookieFrom((await s.callback(`code=good-code&state=${s.state}`)).headers['set-cookie'], 'aic_session')!;
    expect((await server.inject({ url: '/api/me', headers: { ...host, cookie: vs } })).json()).toMatchObject({ name: 'Vic', role: 'viewer' });
    const viewerStop = await server.inject({ method: 'POST', url: '/api/emergency-stop', payload: { reason: 'x' }, headers: { ...host, cookie: vs, 'x-requested-with': 'aic' } });
    expect(viewerStop.statusCode).toBe(403);

    // People management from the dashboard: CEO/admin only; adding needs a fresh sign-in; nobody can mint a second CEO.
    const w = (cookie: string) => ({ ...host, cookie, 'x-requested-with': 'aic' });
    expect((await server.inject({ url: '/api/users', headers: { ...host, cookie: vs } })).statusCode).toBe(403);
    const list = (await server.inject({ url: '/api/users', headers: { ...host, cookie: session } })).json() as { email: string }[];
    expect(list.map((u) => u.email)).toEqual(['casey@acme.test', 'vic@acme.test']);
    expect((await server.inject({ method: 'POST', url: '/api/users', payload: { name: 'Eve', email: 'eve@acme.test', role: 'ceo' }, headers: w(session) })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/api/users', payload: { name: 'Ann', email: 'not-an-email', role: 'approver' }, headers: w(session) })).statusCode).toBe(400);
    const staleAdd = await stale.inject({ method: 'POST', url: '/api/users', payload: { name: 'Ann', email: 'ann@acme.test', role: 'approver' }, headers: w(session) });
    expect(staleAdd.json().step_up_url).toBe('/auth/google?stepup=1');
    const added = await server.inject({ method: 'POST', url: '/api/users', payload: { name: 'Ann', email: 'Ann@Acme.test', role: 'approver' }, headers: w(session) });
    expect(added.statusCode).toBe(200);
    expect(added.json().signIn).toMatch(/Sign in with Google as ann@acme.test/);
    // Removing access ends the viewer's existing Google session immediately; the CEO can't be removed.
    expect((await server.inject({ method: 'POST', url: `/api/users/${b.ceoUserId}/remove`, payload: {}, headers: w(session) })).statusCode).toBe(409);
    expect((await server.inject({ method: 'POST', url: `/api/users/${viewer.userId}/remove`, payload: {}, headers: w(session) })).statusCode).toBe(200);
    expect((await server.inject({ url: '/api/me', headers: { ...host, cookie: vs } })).statusCode).toBe(401);
    s = await signIn('vic@acme.test');
    expect((await s.callback(`code=good-code&state=${s.state}`)).statusCode).toBe(403);

    // Signing out clears the session cookie.
    const out = await server.inject({ method: 'POST', url: '/auth/logout', headers: host });
    expect(String(out.headers['set-cookie'])).toMatch(/aic_session=; .*Max-Age=0/);
  }, 120_000);
});
