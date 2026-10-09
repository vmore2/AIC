import { defineConfig } from 'vitest/config';

// Only the platform's own tests; never agent-written files inside company storage (.aic/).
export default defineConfig({ test: { include: ['test/**/*.test.ts'], exclude: ['**/node_modules/**', '.aic/**', 'teams/**'] } });
