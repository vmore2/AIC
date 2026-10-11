// Database connections the CEO provides (architecture.md §6.8 connectors). The PLATFORM connects —
// employees never see hosts' passwords; they call db.* tools and the gateway runs the statement here.
// Reads run inside READ ONLY transactions with a statement timeout and a row cap; writes are a separate,
// higher-risk tool that only works when the CEO granted read/write.
import mysql from 'mysql2/promise';
import pg from 'pg';

export type DbKind = 'postgres' | 'mysql';
export interface DbConfig { host: string; port: number; database: string; user: string; ssl?: boolean }
export interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean }

export const DEFAULT_PORTS: Record<DbKind, number> = { postgres: 5432, mysql: 3306 };
const TIMEOUT_MS = 10_000;
const MAX_ROWS = 200;
const MAX_CELL = 2_000;

function trimRows(rows: Record<string, unknown>[]): { rows: Record<string, unknown>[]; truncated: boolean } {
  const out = rows.slice(0, MAX_ROWS).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => {
    const s = v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() : Buffer.isBuffer(v) ? `<${v.length} bytes>` : v;
    return [k, typeof s === 'string' && s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s];
  })));
  return { rows: out, truncated: rows.length > MAX_ROWS };
}

/** One short-lived connection per call: nothing pooled, nothing cached between employees. */
async function withPg<T>(cfg: DbConfig, password: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password,
    ssl: cfg.ssl ? { rejectUnauthorized: true } : undefined, connectionTimeoutMillis: TIMEOUT_MS, statement_timeout: TIMEOUT_MS, query_timeout: TIMEOUT_MS + 2_000 });
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => undefined); }
}
async function withMysql<T>(cfg: DbConfig, password: string, fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
  const c = await mysql.createConnection({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password,
    ssl: cfg.ssl ? { rejectUnauthorized: true } : undefined, connectTimeout: TIMEOUT_MS, multipleStatements: false, dateStrings: true });
  try { return await fn(c); } finally { await c.end().catch(() => undefined); }
}

/** Live check before a connection is saved: can we log in, what is it, how many tables. */
export async function checkConnection(kind: DbKind, cfg: DbConfig, password: string): Promise<{ ok: true; version: string; tables: number }> {
  if (kind === 'postgres') return withPg(cfg, password, async (c) => {
    const v = (await c.query<{ v: string }>('SELECT version() AS v')).rows[0]!.v;
    const n = (await c.query<{ n: string }>(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')`)).rows[0]!.n;
    return { ok: true, version: v.split(' on ')[0]!.slice(0, 80), tables: Number(n) };
  });
  return withMysql(cfg, password, async (c) => {
    const [v] = await c.query('SELECT VERSION() AS v') as unknown as [{ v: string }[]];
    const [n] = await c.query('SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()') as unknown as [{ n: number }[]];
    return { ok: true, version: `MySQL ${v[0]!.v}`, tables: Number(n[0]!.n) };
  });
}

/** Tables and columns, so employees can write correct queries without guessing. */
export async function describeSchema(kind: DbKind, cfg: DbConfig, password: string): Promise<{ table: string; columns: string[] }[]> {
  const sql = kind === 'postgres'
    ? `SELECT table_schema || '.' || table_name AS t, column_name || ' ' || data_type AS c FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name, ordinal_position LIMIT 2000`
    : `SELECT table_name AS t, CONCAT(column_name, ' ', data_type) AS c FROM information_schema.columns WHERE table_schema = DATABASE()
       ORDER BY table_name, ordinal_position LIMIT 2000`;
  const rows = (await runQuery(kind, cfg, password, sql, 'read', 5000)).rows as { t: string; c: string }[];
  const byTable = new Map<string, string[]>();
  for (const r of rows) byTable.set(r.t, [...(byTable.get(r.t) ?? []), r.c]);
  return [...byTable].map(([table, columns]) => ({ table, columns }));
}

/**
 * Run ONE statement. `read`: inside a read-only transaction that is always rolled back.
 * `write`: inside a transaction that commits only if the statement succeeds.
 */
export async function runQuery(kind: DbKind, cfg: DbConfig, password: string, sql: string, access: 'read' | 'write', rowCap = MAX_ROWS): Promise<QueryResult> {
  const stmt = sql.trim().replace(/;+\s*$/, '');
  if (!stmt) throw new Error('Empty statement');
  if (stmt.includes(';')) throw new Error('Run one statement at a time (no semicolons inside the statement)');
  if (kind === 'postgres') return withPg(cfg, password, async (c) => {
    await c.query(access === 'read' ? 'BEGIN READ ONLY' : 'BEGIN');
    try {
      const r = await c.query<Record<string, unknown>>(stmt);
      const res = { columns: r.fields?.map((f) => f.name) ?? [], ...cap(r.rows ?? [], rowCap), rowCount: r.rowCount ?? r.rows?.length ?? 0 };
      await c.query(access === 'read' ? 'ROLLBACK' : 'COMMIT');
      return res;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
  });
  return withMysql(cfg, password, async (c) => {
    await c.query(`SET SESSION max_execution_time = ${TIMEOUT_MS}`).catch(() => undefined); // MySQL 5.7.8+; ignored elsewhere
    await c.query(access === 'read' ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');
    try {
      const [rows, fields] = await c.query(stmt) as unknown as [Record<string, unknown>[] | { affectedRows: number }, { name: string }[] | undefined];
      const list = Array.isArray(rows) ? rows : [];
      const res = { columns: fields?.map((f) => f.name) ?? [], ...cap(list, rowCap), rowCount: Array.isArray(rows) ? rows.length : rows.affectedRows };
      await c.query(access === 'read' ? 'ROLLBACK' : 'COMMIT');
      return res;
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
  });
}

function cap(rows: Record<string, unknown>[], rowCap: number) {
  const t = trimRows(rows.slice(0, rowCap + 1));
  return { rows: t.rows.slice(0, rowCap), truncated: rows.length > rowCap || t.truncated };
}
