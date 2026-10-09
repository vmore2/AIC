#!/usr/bin/env node
// Thin launcher so `aic …` works from any directory without a build step.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tsx = import.meta.resolve('tsx/esm');
const r = spawnSync(process.execPath, ['--import', tsx, path.join(root, 'src/cli/main.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
