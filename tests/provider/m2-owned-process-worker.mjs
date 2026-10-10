// Own abrupt-bridge-death fixture, never a model/native submission.
import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api } from './helpers.mjs';
const cwd = resolve(process.argv[2]), file = join(cwd, 'owned.json');
const native = new api.NativeProcess({ executable: process.execPath,
  args: [resolve('tests/provider/fake-v4.mjs'), 'detached-descendant', file], cwd,
  env: api.childEnvironment(process.env, { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }) }, 1, null, () => {}, () => {});
for (let n = 0; n < 600; n++) {
  if (existsSync(file)) {
    const pid = JSON.parse(readFileSync(file, 'utf8')).pid;
    if (native.ownedDescendantPids.has(pid)) {
      writeFileSync(join(cwd, 'ready.tmp'), JSON.stringify({ bridgePid: process.pid, groupPid: native.child.pid, nativePid: native.nativePid, escapedPid: pid }), 'utf8');
      renameSync(join(cwd, 'ready.tmp'), join(cwd, 'ready.json'));
      break;
    }
  }
  await delay(10);
  if (n === 599) throw Error('Own descendant registration timeout');
}
process.stdin.resume();
