import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api } from './helpers.mjs';

const base = resolve(process.env.ZCODE_CONNECTION_TEST_ROOT ?? '.local/M1/offline');
mkdirSync(base, { recursive: true });
const options = { permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null };
for (const fault of ['bind', 'subscribe', 'ready', 'reject', 'timeout', 'release', 'death'])
test('M1 actual prepare/attach pending recovery: ' + fault, async () => {
  const root = mkdtempSync(join(base, 'fault-')), builtin = join(root, 'builtin.json');
  writeFileSync(builtin, '{}', 'utf8');
  const auth = new api.ReadOnlyAuth(join(root, 'synthetic-missing')); auth.read = () => ({ apiKey: 'SYNTHETIC_ONLY' });
  let creates = 0, inputs = 0, child, late; const evidence = [], output = [];
  const runtime = api.createNativeServices(join(root, 'native'), { auth,
    discovery: () => ({ installed: true, supported: true }),
    paths: { executable: process.execPath, script: resolve('tests/provider/fake-v4.mjs'), builtin },
    configure: async c => {
      child = c; late = c.onMessage; const request = c.request.bind(c);
      c.request = async (method, params) => {
        if (method === 'session/create') creates++;
        if (params?.type === 'sendText') inputs++;
        if (method === 'v4/conversation/subscribe' && fault === 'subscribe') throw Error('synthetic subscribe failure');
        if (params?.type === 'sendText' && fault === 'reject') return { status: 'rejected' };
        return request(method, params);
      };
      await c.request('runtime/capabilities', {});
    } });
  runtime.services.validateSelection = async () => {};
  runtime.services.observe = e => evidence.push(e);
  const prepare = runtime.services.prepare;
  runtime.services.prepare = async (...args) => {
    const setup = await prepare(...args);
    if (fault === 'bind') setup.bindSession = () => { throw Error('synthetic bind failure'); };
    if (fault === 'ready') setup.readySession = async () => { throw Error('synthetic native readiness failure'); };
    return setup;
  };
  const bridge = api.createZCodeBridge(runtime.services, m => output.push(m)); let ordinal = 0;
  const rpc = async (method, params) => {
    const id = ++ordinal; bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    for (let i = 0; i < 500; i++) { const m = output.find(m => m.id === id); if (m) return m; await delay(10); }
    throw Error('RPC timeout');
  };
  const timer = globalThis.setTimeout;
  try {
    const start = { threadId: 'own-fault', cwd: root, options, instructionMode: 'append' };
    const result = await rpc('thread/start', start);
    if (['bind', 'subscribe', 'ready'].includes(fault)) {
      assert.ok(result.error);
      const identity = output.find(m => m.method === 'thread/identity').params.providerThreadId;
      assert.ok(identity); assert.ok(output.some(m => m.method === 'error' && m.params.providerThreadId === identity));
      assert.ok((await rpc('thread/start', start)).error); assert.equal(creates, 1);
      const binding = JSON.parse(readFileSync(join(api.sessionDataDir(runtime.root(), root, start.threadId), 'bb-binding.json'), 'utf8'));
      assert.equal(fault === 'bind' ? binding.creationPending : binding.nativeSessionId === identity, true);
      await assert.rejects(prepare(root, api.executionOptions(options), { threadId: start.threadId }), /no create fallback/);
      assert.equal(inputs, 0);
    } else {
      assert.ok(result.result, 'attach must succeed before injecting the pending-input timeout');
      const nativeId = result.result.providerThreadId;
      // Scope this fault to the pending input, not concurrent process startup
      // or the capabilities/subscribe RPCs required to establish the fixture.
      if (fault === 'timeout') globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 60_000 ? 200 : ms, ...args);
      const turn = await rpc('turn/start', { threadId: start.threadId, providerThreadId: nativeId,
        clientRequestId: 'creq_2222222222', options, input: [{ type: 'text', text: '/synthetic-headerless', mentions: [] }] });
      if (fault === 'reject') assert.ok(turn.error); else assert.ok(turn.result);
      if (fault === 'release') assert.ok((await rpc('thread/stop', { threadId: start.threadId, providerThreadId: nativeId, intent: 'release', activeTurnId: null })).result);
      if (fault === 'death') { assert.ok(child.nativePid); process.kill(child.nativePid, 'SIGKILL'); }
      if (fault === 'timeout') {
        for (let i = 0; i < 150 && !output.some(m => m.method === 'error' && m.params.message.includes('unresolved')); i++) await delay(10);
        assert.equal(child.child.exitCode, null); assert.equal(inputs, 1);
        assert.equal(evidence.filter(e => e.event === 'pending-closed').length, 0);
        assert.ok((await rpc('thread/stop', { threadId: start.threadId, providerThreadId: nativeId, intent: 'release', activeTurnId: null })).result);
      }
      for (let i = 0; i < 150 && !evidence.some(e => e.event === 'pending-closed'); i++) await delay(10);
      const closure = evidence.filter(e => e.event === 'pending-closed'); assert.equal(closure.length, 1);
      assert.equal(closure[0].outcome, fault === 'reject' ? 'rejected' : 'unknown');
      await child.close(); await delay(30);
      const n = output.length;
      late({ method: 'v4/conversation/frame', params: {} }, child.generation);
      await delay(250); assert.equal(output.length, n, 'late callback/timer cannot project after closure');
      assert.equal(output.flatMap(m => m.params?.deltas ?? []).filter(d => d.kind === 'turn.boundary').length, 0,
        'unaccepted pending never invents a successful or identified turn');
    }
    assert.equal(await child.close(), 0);
  } finally { globalThis.setTimeout = timer; await bridge.close(); await runtime.close(); rmSync(root, { recursive: true }); }
});

test('M1 semantic equality preserves nested array order and unknown fields', () => {
  const s = row => ({ logEpoch: 'publisher', rows: { totalCount: 1, firstRowId: 1, window: [row] } });
  const row = { rowId: 1, kind: 'future', unknown: { a: 1, b: [1, 2] } };
  assert.equal(api.retainedRows(s(row), s({ kind: 'future', unknown: { b: [1, 2], a: 1 }, rowId: 1 })), true);
  assert.equal(api.retainedRows(s(row), s({ ...row, unknown: { a: 1, b: [2, 1] } })), false);
  assert.equal(api.retainedRows(s(row), s({ ...row, unknown: { a: 1 } })), false);
  const header = { rowId: 1, kind: 'turnHeader', state: 'completedSuccess', createdAt: 100, createdAtSeq: 1, startedAt: 100, endedAt: 200, activeMs: 100 };
  assert.equal(api.retainedRows(s(header), s({ ...header, createdAt: 200, createdAtSeq: 3, startedAt: 200, endedAt: 400, activeMs: 200 })), true);
  for (const createdAt of [undefined, '100', {}, null]) {
    const changed = { ...header, createdAt }; if (createdAt === undefined) delete changed.createdAt;
    assert.equal(api.retainedRows(s(header), s(changed)), false);
  }
  assert.equal(api.retainedRows(s({ ...row, startedAt: 1 }), s({ ...row, startedAt: 2 })), false, 'unknown timing names on unknown kind stay substantive');
});
