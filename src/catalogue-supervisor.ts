// Bundled JS runs on process.execPath (bb's Node), never an external runtime.
// The bridge spawns this leader detached; its directly spawned native child
// inherits the group. EOF on the bridge pipe survives abrupt bridge SIGKILL.
// Escaped descendants require an in-memory ancestry observation and a fresh
// birth/command match. No persisted PID/lease survives this live owner.
import { ownedDescendantProgram } from './owned-descendants.ts';
export const catalogueSupervisor = ownedDescendantProgram + String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { Socket } = require('node:net');
const launch = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
let child, shutting = false, finished = false, code = 0;
const timers = [];
const descendants = new OwnedDescendants(process.pid);
const announced = new Set();
let forced = false, watchTimer;
let activity = 'unknown', controlText = '';
let control;
function report(event, extra = {}) {
  if (control) control.write(JSON.stringify({ event, ...extra }) + '\n');
}
if (launch.control) {
  control = new Socket({ fd: 3, readable: true, writable: true });
  control.on('data', chunk => {
    controlText += chunk.toString('utf8');
    if (controlText.length > 4096) { shutdown(); force(); return; }
    let newline;
    while ((newline = controlText.indexOf('\n')) >= 0) {
      const line = controlText.slice(0, newline); controlText = controlText.slice(newline + 1);
      if (line === 'abort') { shutdown(); force(); }
      else if (line === 'active' || line === 'idle' || line === 'unknown') {
        const changed = activity !== line; activity = line;
        if (changed && !shutting) { clearTimeout(watchTimer); watch(); }
      } else { shutdown(); force(); }
    }
  });
  control.on('end', shutdown); control.on('error', shutdown);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.stdin.on('error', shutdown);
process.stdout.on('error', shutdown);
process.stderr.on('error', shutdown);
function inventory() {
  const args = ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,comm='];
  const inventory = spawnSync('/bin/ps', args,
    { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  if (inventory.error || inventory.status !== 0) throw Error('group inventory unavailable');
  const rows = parseOwnedInventory(inventory.stdout, inventory.pid);
  descendants.observe(rows, child?.pid, child && child.exitCode === null && child.signalCode === null);
  for (const row of descendants.escaped(rows).live) if (!announced.has(row.pid)) {
    announced.add(row.pid); report('descendant-owned', { pid: row.pid });
  }
  return rows;
}
function others(rows) {
  return [...rows.values()].some(row => row.group === process.pid && row.pid !== process.pid && row.state[0] !== 'Z');
}
function escapedSignal(value) {
  const owned = descendants.escaped(inventory());
  for (const row of owned.live) {
    // Fresh positive-PID identity check; never a detached numeric PGID kill.
    const current = descendants.escaped(inventory()).live.find(r => r.pid === row.pid &&
      r.started === row.started && r.command === row.command);
    if (!current) continue;
    try { process.kill(current.pid, value); }
    catch (e) { if (e.code !== 'ESRCH') code = 1; }
  }
}
function probe() {
  if (finished) return;
  try {
    const rows = inventory(), escaped = descendants.escaped(rows);
    if (!escaped.live.length && !escaped.unknown && child && (child.exitCode !== null || child.signalCode !== null)) {
      if (!others(rows)) { report('escaped-settled'); finish(); }
      else if (forced) groupKill();
    }
  }
  // A failed read grants neither settlement nor signal rights. Retry a fresh
  // read under the same live owner; the bounded deadline reports uncertainty.
  catch { }
}
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(watchTimer);
  for (const timer of timers) clearTimeout(timer);
  process.exit(code);
}
function groupKill() {
  // Preserve this live ownership anchor until escaped identities settle.
  report('escaped-settled');
  try { process.kill(-process.pid, 'SIGKILL'); }
  catch (e) { code = 1; report('signal-error', { code: e.code || 'UNKNOWN', stage: 'SIGKILL' }); }
}
function force() {
  if (finished) return;
  forced = true;
  try { escapedSignal('SIGKILL'); } catch { code = 1; }
  child?.kill('SIGKILL');
  probe();
}
function shutdown() {
  if (shutting) return;
  shutting = true;
  child?.stdin.end();
  timers.push(setTimeout(() => {
    probe(); if (finished) return;
    try { escapedSignal('SIGTERM'); } catch { code = 1; }
    try { process.kill(-process.pid, 'SIGTERM'); }
    catch (e) { code = 1; report('signal-error', { code: e.code || 'UNKNOWN', stage: 'SIGTERM' }); }
  }, 1000));
  timers.push(setTimeout(force, 5000));
  timers.push(setTimeout(() => {
    if (finished) return;
    code = 1; report('descendant-error', { code: 'SETTLEMENT_UNCONFIRMED' }); finish();
  }, 6000));
  const poll = () => { probe(); if (!finished) timers.push(setTimeout(poll, 50)); };
  timers.push(setTimeout(poll, 20));
}
function watch() {
  if (finished || shutting) return;
  try { inventory(); } catch { /* Unknown never grants ownership or settlement. */ }
  watchTimer = setTimeout(watch, activity !== 'idle' ? 100 : 2000);
}
try {
  child = spawn(launch.executable, launch.args, { cwd: process.cwd(), env: process.env, detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => { report('stdin-error'); shutdown(); force(); });
  child.on('spawn', () => report('spawn', { pid: child.pid }));
  child.on('error', e => { code = 1; report('spawn-error', { code: e.code || 'UNKNOWN' }); shutdown(); });
  child.on('exit', (value, signalCode) => {
    report('native-exit', { code: value, signal: signalCode }); shutdown();
    timers.push(setTimeout(force, 1000));
  });
  child.on('close', value => { if (value) code = value; shutdown(); });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  process.stdin.pipe(child.stdin);
  watch();
  if (process.stdin.readableEnded) shutdown();
} catch { code = 1; shutdown(); }
`;
