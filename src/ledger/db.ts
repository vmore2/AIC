// Database port. The ledger runs on the customer's PostgreSQL (via `pg`) or, for local
// evaluation, on an embedded PostgreSQL (PGlite). Same SQL, same semantics.
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * PostgreSQL text and jsonb cannot hold NUL characters; agent and tool output sometimes contains them
 * (binary bytes in test logs). Strip them from every value we write so one stray byte can't crash a run.
 */
export function stripNul<T>(v: T): T {
  // Raw NUL characters, and the \u0000 escape JSON.stringify writes for them (jsonb rejects both).
  if (typeof v === 'string') return (v.includes('\u0000') || v.includes('\\u0000') ? v.replace(/\u0000/g, '').replace(/(?<!\\)\\u0000/g, '') : v) as T;
  if (Array.isArray(v)) return v.map(stripNul) as T;
  if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripNul(x)])) as T;
  return v;
}
const clean = (params?: unknown[]) => (params ? params.map(stripNul) : params);

export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const pg = new PGlite(dataDir);
  await pg.waitReady;
  return {
    query: async (sql, params) => pg.query(sql, clean(params) as unknown[]) as never,
    tx: (fn) => pg.transaction(async (t) => fn({ query: async (sql, params) => t.query(sql, clean(params) as unknown[]) as never })),
    exec: async (sql) => { await pg.exec(sql); },
    close: () => pg.close(),
  };
}

export async function openPostgres(connectionString: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    query: async (sql, params) => pool.query(sql, clean(params) as unknown[]) as never,
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await fn({ query: async (sql, params) => client.query(sql, clean(params) as unknown[]) as never });
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    exec: async (sql) => { await pool.query(sql); },
    close: () => pool.end(),
  };
}

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** A restricted runtime role (docs/production-roles.sql) cannot change the schema; say how to apply migrations. */
function ownerNeeded(what: string, e: unknown): Error {
  if ((e as { code?: string }).code !== '42501') return e as Error;
  return new Error(`${what} needs the database owner, but the platform is connected as a restricted role. Run \`aic doctor\` once with the owner's `
    + 'DATABASE_URL (it applies migrations), re-run docs/production-roles.sql, then switch back to the restricted role.');
}

export async function migrate(db: Db): Promise<string[]> {
  // Only create the bookkeeping table when missing: even CREATE TABLE IF NOT EXISTS needs CREATE rights on the
  // schema, which the restricted production role deliberately lacks.
  const exists = (await db.query<{ t: string | null }>(`SELECT to_regclass('schema_migrations')::text AS t`)).rows[0]?.t;
  if (!exists) {
    try { await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); }
    catch (e) { throw ownerNeeded('Creating the ledger schema', e); }
  }
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    if (!/^[\w.-]+$/.test(f)) throw new Error(`Unsafe migration file name: ${f}`);
    const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    // One multi-statement script per migration, atomically (both drivers use the simple query protocol here).
    try { await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations(name) VALUES ('${f}');\nCOMMIT;`); }
    catch (e) { await db.exec('ROLLBACK').catch(() => undefined); throw ownerNeeded(`Database migration ${f}`, e); }
    applied.push(f);
  }
  return applied;
}
