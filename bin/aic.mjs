#!/usr/bin/env node
// Thin launcher so `npx aic …` works without a build step.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'src/cli/main.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
