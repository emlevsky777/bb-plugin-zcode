import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import './guard.mjs';
if (!process.argv.includes('--noEmit')) rmSync('dist', { recursive: true, force: true });
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
