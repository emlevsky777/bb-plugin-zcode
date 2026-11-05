import './guard.mjs';
import { readdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const tools = ['m1-recompute-mutations.test.mjs', 'live-stand.test.mjs'];
const tests = readdirSync('tests/provider').filter(name => name.endsWith('.test.mjs') && !tools.includes(name)).map(name => `tests/provider/${name}`);
const ownedRoot = process.env.ZCODE_CONNECTION_TEST_ROOT === undefined
  ? realpathSync(mkdtempSync(join(tmpdir(), 'zcode-tests-'))) : undefined;
try {
  const env = ownedRoot === undefined ? process.env : { ...process.env, ZCODE_CONNECTION_TEST_ROOT: ownedRoot };
  const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit', env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  if (ownedRoot !== undefined) rmSync(ownedRoot, { recursive: true, force: true });
}
