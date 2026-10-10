import './guard.mjs';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const tools = ['m1-recompute-mutations.test.mjs', 'live-stand.test.mjs'];
const tests = readdirSync('tests/provider').filter(name => name.endsWith('.test.mjs') && !tools.includes(name)).map(name => `tests/provider/${name}`);
const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
