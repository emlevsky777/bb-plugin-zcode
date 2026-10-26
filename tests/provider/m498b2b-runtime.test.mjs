import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api, plugin, rows, snapshot, frame, wires } from './helpers.mjs';
const options = { permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null, model: 'GLM-5.3', reasoningLevel: 'high' };

test('memory fallback defaults ON, reads current per-command settings, validates booleans and permits long instructions', async () => {
  let registration, descriptors;
  await plugin({ settings: { define: d => { descriptors = d; return { get: async () => ({}) }; } }, providers: { register: r => { registration = r; } } });
  assert.equal(descriptors.memoryEnabled.default, true);
  assert.equal(registration.deriveProviderOptions({ settings: {} }).memoryEnabled, true);
  assert.equal(registration.deriveProviderOptions({ settings: { memoryEnabled: false } }).memoryEnabled, false);
  assert.equal(api.executionOptions(options).memoryEnabled, true);
  assert.throws(() => api.executionOptions({ ...options, providerOptions: { memoryEnabled: 'false' } }), /memory setting/);
  assert.equal(api.executionOptions({ ...options, instructions: 'x'.repeat(65537) }).instructions.length, 65537);
});

test('actual reverse runtime preferences keep active OFF through steer, next ordinary applies ON with same identity', async () => {
  const root = mkdtempSync('/tmp/m498b2b-'), file = join(root, 'sessions.json'), out = [], children = [];
  const bridge = api.createZCodeBridge({ prepare: async () => ({ launch: { executable: process.execPath, args: [resolve('tests/provider/fake-v4.mjs'), 'v4', file], cwd: root, env: api.childEnvironment(process.env, {}) },
    auth: new api.ReadOnlyAuth(join(root, 'missing')), configure: async child => { children.push(child); } }),
    health: async () => ({}), installation: async () => ({}), models: async () => ({}), validateSelection: async () => {} }, m => out.push(m));
  let ordinal = 0;
  async function rpc(method, params, fail = false) {
    const id = ++ordinal; bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    for (let i = 0; i < 1200; i++) { const r = out.find(m => m.id === id); if (r) { assert.equal(!!r.error, fail, JSON.stringify(r)); return r.result; } await delay(5); }
    throw Error('RPC timeout');
  }
  const active = { ...options, providerOptions: { memoryEnabled: false } }, next = { ...options, providerOptions: { memoryEnabled: true } };
  let concurrentReads = 0;
  const readErrors = [];
  const reader = setInterval(() => {
    if (!existsSync(file)) return;
    try { JSON.parse(readFileSync(file, 'utf8')); concurrentReads++; } catch (error) { readErrors.push(error); }
  }, 1);
  try {
    const { providerThreadId } = await rpc('thread/start', { threadId: 'memory-own', cwd: root, instructionMode: 'append', options: active });
    const state = () => JSON.parse(readFileSync(file, 'utf8'))[providerThreadId];
    async function preference(expected) {
      await children.at(-1).request('fixture/preferences', {});
      for (let i = 0; i < 500 && state().runtimePreferences?.memoryEnabled !== expected; i++) await delay(5);
      assert.equal(state().runtimePreferences.memoryEnabled, expected);
    }
    await preference(false);
    const turn = { threadId: 'memory-own', providerThreadId, clientRequestId: 'creq_2222222222', options: active, input: [{ type: 'text', text: '/wait-for-interrupt' }] };
    await rpc('turn/start', turn); await delay(50);
    const expectedTurnId = state().rows.window.find(r => r.kind === 'turnHeader').turnId;
    for (let i = 0; i < 1025; i++) await rpc('turn/steer', { ...turn, expectedTurnId, options: next,
      clientRequestId: 'creq_' + i.toString(16).replaceAll('0', 'u').replaceAll('1', 'v').padStart(10, 'k'), input: [{ type: 'text', text: '/steer-lifetime' }] });
    const steer = { ...turn, expectedTurnId, options: next, clientRequestId: 'creq_3333333333', input: [{ type: 'text', text: 'guide' }] };
    await rpc('turn/steer', steer); await preference(false);
    await rpc('turn/steer', steer, true); // Same client input never reaches native twice.
    assert.equal(state().steerCommands.length, 1026);
    await delay(180);
    await rpc('turn/start', { ...turn, options: next, clientRequestId: 'creq_4444444444', input: [{ type: 'text', text: 'ordinary' }] });
    await preference(true);
    assert.equal(children.length, 2);
    assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).length, 1);
    assert.ok(concurrentReads > 100, `Concurrent reads: ${concurrentReads}`);
    assert.deepEqual(readErrors, []);
  } finally { clearInterval(reader); await bridge.close(); rmSync(root, { recursive: true }); }
});

test('assembled history and unfinished projection exceed former row/checkpoint limits without losing active items', () => {
  const rs = [rows()[0]]; rs[0].state = 'running';
  for (let i = 0; i < 5000; i++) rs.push({ rowId: i + 2, kind: 'assistantText', turnId: 'turn1', state: 'streaming', text: 'text' });
  const s = api.parseSnapshot(snapshot(rs), () => {}), t = new api.EventTranslator('session1', 'epoch1', 1, () => {});
  assert.equal(t.project(s, 1).filter(d => d.kind === 'item.open').length, 5000);
  const cp = JSON.parse(t.checkpoint());
  const large = JSON.stringify({ ...cp, unused: 'x'.repeat(1024 * 1024) });
  const restored = new api.EventTranslator('session1', 'epoch1', 1, () => {});
  restored.restore(large);
  assert.deepEqual(restored.project(s, 1), []);
  const big = snapshot([{ rowId: 1, kind: 'future', text: 'x'.repeat(17 * 1024 * 1024) }]);
  assert.equal(api.parseSnapshot(big, () => {}).rows.window.length, 1);
});

test('native V4 concurrency/timeout/staging limits and safe stdout diagnostics', () => {
  const warnings = [], d = new api.FrameDecoder(e => warnings.push(e));
  assert.equal(d.limits.maxAssemblies, 32); assert.equal(d.limits.timeoutMs, 30000);
  const fragment = wires(frame())[0];
  for (let i = 0; i < 32; i++) d.ingest({ ...fragment, logicalFrameId: String(i) }, 0);
  d.expire(10000); assert.equal(d.pending, 32);
  assert.throws(() => d.ingest({ ...fragment, logicalFrameId: 'extra' }, 10000), /too-many/);
  d.expire(30000); assert.equal(d.pending, 0);
  const staging = new api.FrameDecoder(() => {}, { maxStagedBytes: 1 });
  assert.throws(() => staging.ingest(fragment), /staging-too-large/);
  const decoder = new api.JsonLineDecoder(undefined, e => warnings.push(e));
  assert.deepEqual(decoder.feed(Buffer.from('noise PRIVATE\n{"id":1,"result":{}}\n')), [{ id: 1, result: {} }]);
  assert.ok(warnings.some(e => e.code === 'unrelated-native-stdout'));
  assert.ok(!JSON.stringify(warnings).includes('PRIVATE'));
  assert.throws(() => decoder.feed(Buffer.from('{bad\n')), /malformed/);
});
