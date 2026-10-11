import { defineConfig } from 'vitest/config';

// Only the platform's own tests; never agent-written files inside company storage (.aic/).
// Each test file boots an embedded Postgres, git repos and sometimes Docker containers, so running every
// file at once starves the machine and turns into timeouts; a few at a time is faster overall.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], exclude: ['**/node_modules/**', '.aic/**', 'teams/**'], testTimeout: 30_000, maxWorkers: 4 } });
