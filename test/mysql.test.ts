// The database connector against a real MySQL (skipped unless Docker has the mysql:8.4 image).
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkConnection, describeSchema, runQuery, type DbConfig } from '../src/connections/databases.js';

const IMAGE = 'mysql:8.4';
const PASSWORD = 'my-Secret-9911';
const ready = (() => { try { execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: 15_000 }); return true; } catch { return false; } })();
let container = '';
let cfg: DbConfig;

beforeAll(async () => {
  if (!ready) return;
  container = execFileSync('docker', ['run', '-d', '--rm', '-e', `MYSQL_ROOT_PASSWORD=${PASSWORD}`, '-e', 'MYSQL_DATABASE=shop', '-p', '127.0.0.1::3306', IMAGE], { encoding: 'utf8' }).trim();
  const port = Number(execFileSync('docker', ['port', container, '3306/tcp'], { encoding: 'utf8' }).trim().split('\n')[0]!.split(':').pop());
  cfg = { host: '127.0.0.1', port, database: 'shop', user: 'root' };
  for (let i = 0; i < 90; i++) {
    try { await checkConnection('mysql', cfg, PASSWORD); return; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
}, 180_000);
afterAll(() => { if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); });

describe.skipIf(!ready)('MySQL connector (live)', () => {
  it('checks, writes in a transaction, reads read-only, and describes the schema', async () => {
    expect(await checkConnection('mysql', cfg, PASSWORD)).toMatchObject({ ok: true, version: expect.stringMatching(/^MySQL 8\.4/), tables: 0 });
    await expect(checkConnection('mysql', cfg, 'wrong')).rejects.toThrow(/Access denied/);
    await runQuery('mysql', cfg, PASSWORD, 'CREATE TABLE orders (id int auto_increment primary key, item varchar(40) not null, qty int not null)', 'write');
    expect((await runQuery('mysql', cfg, PASSWORD, "INSERT INTO orders (item, qty) VALUES ('apple', 3), ('pear', 5)", 'write')).rowCount).toBe(2);
    const r = await runQuery('mysql', cfg, PASSWORD, 'SELECT item, qty FROM orders ORDER BY id', 'read');
    expect(r).toMatchObject({ columns: ['item', 'qty'], rows: [{ item: 'apple', qty: 3 }, { item: 'pear', qty: 5 }], truncated: false });
    await expect(runQuery('mysql', cfg, PASSWORD, "INSERT INTO orders (item, qty) VALUES ('x', 1)", 'read')).rejects.toThrow(/READ ONLY transaction/i);
    await expect(runQuery('mysql', cfg, PASSWORD, 'SELECT 1; DROP TABLE orders', 'read')).rejects.toThrow(/one statement/);
    expect(await describeSchema('mysql', cfg, PASSWORD)).toEqual([{ table: 'orders', columns: ['id int', 'item varchar', 'qty int'] }]);
    expect((await runQuery('mysql', cfg, PASSWORD, 'SELECT count(*) AS n FROM orders', 'read')).rows[0]).toEqual({ n: 2 });
  }, 120_000);
});
