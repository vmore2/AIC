// Google sign-in (OpenID Connect, authorization code + PKCE) for the dashboard.
// - Only people the CEO has added (by email) can sign in; Google proves the email.
// - Sessions are HMAC-signed, HttpOnly cookies. Governance actions need a FRESH sign-in (step-up).
// - Cookie-authenticated writes must carry the `x-requested-with: aic` header (CSRF defense;
//   the server enables no CORS, so other sites cannot send it).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '../ledger/db.js';
import type { Principal } from '../domain/types.js';

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Public base URL of this dashboard, e.g. http://localhost:4100 (must match the OAuth redirect URI). */
  publicUrl: string;
  sessionSecret: string;
  allowedDomain?: string;
  /** Overridable for tests / Google Workspace setups. */
  authorizeUrl?: string;
  tokenUrl?: string;
  issuer?: string[];
  sessionHours?: number;
  stepUpMinutes?: number;
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (secret: string, data: string) => b64(createHmac('sha256', secret).update(data).digest());

function seal(secret: string, payload: object): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(secret, body)}`;
}
function unseal<T>(secret: string, value: string | undefined): T | null {
  if (!value) return null;
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  const expected = sign(secret, body);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T; } catch { return null; }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Session signing key: from the environment, else generated once into the customer's storage. */
export function sessionSecret(storagePath: string, fromEnv?: string): string {
  if (fromEnv) return fromEnv;
  const file = path.join(storagePath, 'session.key');
  if (!existsSync(file)) { mkdirSync(storagePath, { recursive: true }); writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600 }); }
  return readFileSync(file, 'utf8').trim();
}

interface Session { uid: string; email: string; iat: number; auth: number; exp: number }

export class GoogleAuth {
  readonly cookieName = 'aic_session';
  constructor(readonly cfg: GoogleAuthConfig, private readonly db: Queryable) {}

  private get secure() { return this.cfg.publicUrl.startsWith('https://'); }
  private cookie(name: string, value: string, maxAgeS: number) {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${this.secure ? '; Secure' : ''}`;
  }

  /** Principal from a valid session cookie, or null. Step-up only for a recent sign-in. */
  async principalFrom(req: FastifyRequest): Promise<Principal | null> {
    const s = unseal<Session>(this.cfg.sessionSecret, parseCookies(req.headers.cookie)[this.cookieName]);
    if (!s || s.exp < Date.now()) return null;
    const u = (await this.db.query<{ id: string }>('SELECT id FROM users WHERE id = $1 AND lower(email) = lower($2)', [s.uid, s.email])).rows[0];
    if (!u) return null;
    const fresh = Date.now() - s.auth < (this.cfg.stepUpMinutes ?? 15) * 60_000;
    return { type: 'user', id: u.id, stepUp: fresh };
  }

  register(server: FastifyInstance) {
    const redirectUri = `${this.cfg.publicUrl.replace(/\/$/, '')}/auth/google/callback`;

    server.get<{ Querystring: { stepup?: string } }>('/auth/google', async (req, reply) => {
      // Cookies are per host: start the flow on the same host Google will redirect back to.
      const pub = new URL(this.cfg.publicUrl);
      if (req.headers.host && req.headers.host !== pub.host) return reply.redirect(`${pub.origin}${req.url}`);
      const state = b64(randomBytes(24));
      const nonce = b64(randomBytes(24));
      const verifier = b64(randomBytes(32));
      const challenge = b64(createHash('sha256').update(verifier).digest());
      const flow = seal(this.cfg.sessionSecret, { state, nonce, verifier, exp: Date.now() + 10 * 60_000 });
      const params = new URLSearchParams({
        client_id: this.cfg.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile',
        state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
        ...(req.query.stepup ? { max_age: '0' } : {}), ...(this.cfg.allowedDomain ? { hd: this.cfg.allowedDomain } : {}),
      });
      reply.header('set-cookie', this.cookie('aic_oauth', flow, 600));
      return reply.redirect(`${this.cfg.authorizeUrl ?? 'https://accounts.google.com/o/oauth2/v2/auth'}?${params}`);
    });

    server.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/auth/google/callback', async (req, reply) => {
      const fail = (status: number, msg: string) => reply.code(status).type('text/html').header('set-cookie', this.cookie('aic_oauth', '', 0))
        .send(`<p>${msg.replace(/</g, '&lt;')}</p><p><a href="/">Back</a></p>`);
      if (req.query.error) return fail(400, `Google sign-in was cancelled (${req.query.error}).`);
      const flow = unseal<{ state: string; nonce: string; verifier: string; exp: number }>(this.cfg.sessionSecret, parseCookies(req.headers.cookie)['aic_oauth']);
      if (!flow || flow.exp < Date.now() || !req.query.state || req.query.state !== flow.state || !req.query.code) return fail(400, 'Sign-in expired or was tampered with. Please try again.');
      const res = await fetch(this.cfg.tokenUrl ?? 'https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: req.query.code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: flow.verifier }),
      });
      if (!res.ok) return fail(401, 'Google did not accept the sign-in code.');
      const tokens = (await res.json()) as { id_token?: string };
      // The ID token came straight from Google's token endpoint over TLS, so per OIDC Core §3.1.3.7 its
      // claims can be trusted without re-verifying the signature; we still validate every claim.
      const claims = tokens.id_token ? JSON.parse(Buffer.from(tokens.id_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown> : null;
      const issuers = this.cfg.issuer ?? ['https://accounts.google.com', 'accounts.google.com'];
      const aud = Array.isArray(claims?.['aud']) ? claims['aud'] as string[] : [claims?.['aud'] as string];
      if (!claims || !issuers.includes(String(claims['iss'])) || !aud.includes(this.cfg.clientId) || Number(claims['exp']) * 1000 < Date.now()
        || claims['nonce'] !== flow.nonce || claims['email_verified'] !== true || typeof claims['email'] !== 'string')
        return fail(401, 'The Google identity could not be verified.');
      const email = String(claims['email']).toLowerCase();
      if (this.cfg.allowedDomain && !email.endsWith(`@${this.cfg.allowedDomain}`) && claims['hd'] !== this.cfg.allowedDomain) return fail(403, 'This Google account is not in the allowed domain.');
      const u = (await this.db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [email])).rows[0];
      if (!u) return fail(403, `${email} has no access to this company. Ask your CEO to add you (aic users add "Your Name" --email ${email}).`);
      const now = Date.now();
      const authTime = typeof claims['auth_time'] === 'number' ? Number(claims['auth_time']) * 1000 : now;
      const session = seal(this.cfg.sessionSecret, { uid: u.id, email, iat: now, auth: authTime, exp: now + (this.cfg.sessionHours ?? 12) * 3600_000 } satisfies Session);
      reply.header('set-cookie', [this.cookie(this.cookieName, session, (this.cfg.sessionHours ?? 12) * 3600), this.cookie('aic_oauth', '', 0)]);
      return reply.redirect('/');
    });

    server.post('/auth/logout', async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.header('set-cookie', this.cookie(this.cookieName, '', 0));
      return { ok: true };
    });
  }
}
