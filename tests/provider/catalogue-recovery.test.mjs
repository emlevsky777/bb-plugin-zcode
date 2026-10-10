import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { api } from './helpers.mjs';
const base = resolve(process.env.ZCODE_CONNECTION_TEST_ROOT ?? '.local/M1-catalogue-simplification/offline');
mkdirSync(base, { recursive: true });
const worker = resolve('tests/provider/catalogue-recovery-worker.mjs');
function run(root, pause = false) {
  // Product gets neither a usable Python override nor a PATH Python fallback.
  const child = spawn(process.execPath, [worker, root, ...(pause ? ['pause'] : [])], {
    env: { ...process.env, PATH: '/nonexistent', ZCODE_PROJECT_PYTHON: '/nonexistent/poisoned-python' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { errors += b; });
  const done = new Promise(resolve => child.on('close', code => resolve({ code, output, errors })));
  return { child, done };
}
function setup() {
  const root = mkdtempSync(join(base, 'recovery-')); mkdirSync(join(root, 'shared'));
  writeFileSync(join(root, 'auth.json'), '{}', 'utf8'); writeFileSync(join(root, 'builtin.json'), '{}', 'utf8'); return root;
}
async function wait(file) { for (let i = 0; i < 600; i++) { if (existsSync(file)) return; await delay(10); } throw Error('own fixture timeout'); }
const events = root => readFileSync(join(root, 'shared/service-evidence.ndjson'), 'utf8').trim().split('\n').map(JSON.parse);
test('abrupt parent death: hanging EOF/TERM-ignore native-shaped child and descendant, group/listeners/late effects settle', async () => {
  const root = setup();
  const owner = spawn(process.execPath, [resolve('tests/provider/catalogue-orphan-worker.mjs'), root], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  owner.stdout.resume(); owner.stderr.resume(); const done = new Promise(r => owner.on('close', r)); let group;
  try {
    await wait(join(root, 'descendant.json')); await wait(join(root, 'group.json'));
    group = JSON.parse(readFileSync(join(root, 'group.json'), 'utf8')).pid;
    const children = ['child.json', 'descendant.json'].map(f => JSON.parse(readFileSync(join(root, f), 'utf8')));
    owner.kill('SIGKILL'); await done;
    for (let i = 0; i < 800 && api.classifyOwnedGroup(group) !== 'absent'; i++) await delay(10);
    assert.equal(api.classifyOwnedGroup(group), 'absent');
    for (const child of children) await new Promise((resolve, reject) => {
      const socket = connect(child.port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); reject(Error('owned listener remains')); });
      socket.once('error', e => { assert.equal(e.code, 'ECONNREFUSED'); resolve(); });
    });
    const after = readFileSync(join(root, 'heartbeat'), 'utf8'); await delay(200); assert.equal(readFileSync(join(root, 'heartbeat'), 'utf8'), after);
  } finally { owner.kill('SIGKILL'); await done; rmSync(root, { recursive: true }); }
});
test('SIGKILL actual loading bridge: Node-owned supervisor settles group, next cold bridge reloads and warm bridge spawns zero', async () => {
  const root = setup(), held = run(root, true), active = [held];
  try {
    await wait(join(root, 'paused.json'));
    const { pid } = JSON.parse(readFileSync(join(root, 'paused.json'), 'utf8'));
    held.child.kill('SIGKILL'); await held.done;
    for (let i = 0; i < 700 && api.classifyOwnedGroup(pid) !== 'absent'; i++) await delay(10);
    assert.equal(api.classifyOwnedGroup(pid), 'absent');
    const next = run(root); active.push(next); const result = await next.done;
    assert.equal(result.code, 0, result.errors); assert.equal(JSON.parse(result.output).models.length, 2);
    const loads = events(root).filter(e => e.event === 'native-startup').length;
    const warm = run(root); active.push(warm); assert.equal((await warm.done).code, 0);
    assert.equal(events(root).filter(e => e.event === 'native-startup').length, loads);
  } finally { for (const x of active) x.child.kill('SIGKILL'); await Promise.all(active.map(x => x.done)); rmSync(root, { recursive: true }); }
});
for (const corrupt of ['{', '{"scope":"unknown","catalogue":{},"future":true}', 'null', '{"scope":"stale","catalogue":{}}'])
test('corrupt/unknown/stale shared cache: concurrent actual services, <=N loads, atomic publication and cold warm hit: ' + corrupt, async () => {
  const root = setup(), active = [];
  try {
    writeFileSync(join(root, 'shared/catalogue-v2.json'), corrupt, 'utf8');
    const legacy = join(root, 'shared/catalogue-v1.json.lock'); writeFileSync(legacy, 'OLD_INERT', 'utf8');
    for (let i = 0; i < 4; i++) active.push(run(root));
    for (const result of await Promise.all(active.map(x => x.done))) { assert.equal(result.code, 0, result.errors); assert.equal(JSON.parse(result.output).models.length, 2); }
    const loads = events(root).filter(e => e.event === 'native-startup').length;
    assert.ok(loads >= 1 && loads <= 4);
    assert.ok(events(root).some(e => e.event === 'catalogue-cache-recovery'));
    assert.equal(JSON.parse(readFileSync(join(root, 'shared/catalogue-v2.json'), 'utf8')).catalogue.models.length, 2);
    assert.equal(readFileSync(legacy, 'utf8'), 'OLD_INERT');
    assert.equal(readdirSync(join(root, 'shared')).filter(f => f.endsWith('.tmp')).length, 0);
    const warm = run(root); active.push(warm); assert.equal((await warm.done).code, 0);
    assert.equal(events(root).filter(e => e.event === 'native-startup').length, loads);
  } finally { for (const x of active) x.child.kill('SIGKILL'); await Promise.all(active.map(x => x.done)); rmSync(root, { recursive: true }); }
});
