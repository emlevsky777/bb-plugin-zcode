import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api } from './helpers.mjs';
import { sanitizeEnvelope } from '../../scripts/provider/sanitize-envelope.mjs';
const base = resolve(process.env.ZCODE_CONNECTION_TEST_ROOT ?? '.local/implementation-3.2.2.C/offline');
mkdirSync(base, { recursive: true });
const options = { permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null };
function runtime() {
  const root = mkdtempSync(base + '/actual-'), builtin = join(root, 'synthetic-builtin.json'); writeFileSync(builtin, '{}', 'utf8');
  let reads = 0, discoveries = 0;
  const auth = new api.ReadOnlyAuth(join(root, 'synthetic-missing')); auth.read = () => { reads++; return { apiKey: 'SYNTHETIC_ONLY' }; };
  const personalHome = join(root, 'personal'); mkdirSync(personalHome);
  const r = api.createNativeServices(join(root, 'data'), { auth, personalHome,
    discovery: () => { discoveries++; return { installed: true, supported: true, sha256: 'synthetic', version: 'synthetic' }; },
    paths: { executable: process.execPath, script: resolve('tests/provider/fake-v4.mjs'), builtin },
    configure: c => c.request('runtime/capabilities', {}).then(() => {}) });
  // Catalogue dependency only is synthetic; actual services.prepare is unchanged.
  r.services.validateSelection = async () => {};
  return { root, r, personalHome, counts: () => ({ reads, discoveries }) };
}
test('M46 malformed personal layer warns on actual bridge resume while preserving native identity and ordinary turn', async () => {
  const { root, r, personalHome } = runtime();
  try { await harness(r, async (rpc, out) => {
    const start = { threadId: 'm46', cwd: root, instructionMode: 'append', options, disallowedTools: [], dynamicTools: [] };
    const native = (await rpc('thread/start', start)).result.providerThreadId;
    const setup = await r.services.prepare(root, api.executionOptions(options), { threadId: 'm46', providerThreadId: native });
    const binding = readFileSync(join(setup.launch.env.HOME, 'bb-binding.json'));
    assert.equal(setup.launch.env.ZCODE_STORAGE_DIR, join(r.root(), 'data'));
    assert.equal(setup.launch.env.ZCODE_RUNTIME_ENV, undefined, 'ordinary launch uses ZCode production default');
    assert.equal(setup.launch.env.ZCODE_HTTP_PROXY, undefined);
    assert.equal(setup.launch.env.ZCODE_AGENT_CA_CERT, undefined);
    assert.equal(setup.launch.env.ZCODE_SESSION_DB_PATH, join(setup.launch.env.HOME, '.zcode/cli/db/db.sqlite'));
    mkdirSync(join(personalHome, '.zcode/cli'), { recursive: true }); writeFileSync(join(personalHome, '.zcode/cli/config.json'), '{malformed');
    await rpc('thread/stop', { threadId: 'm46', providerThreadId: native, activeTurnId: null, intent: 'release' });
    const resumed = await rpc('thread/resume', { ...start, providerThreadId: native });
    assert.equal(resumed.result.providerThreadId, native);
    assert.ok(out.some(m => m.params?.deltas?.some(d => d.kind === 'provider.warning' && d.summary.includes('Personal ZCode settings'))));
    await rpc('turn/start', { threadId: 'm46', providerThreadId: native, clientRequestId: 'creq_2222222222', options,
      input: [{ type: 'text', text: 'ordinary', mentions: [] }] });
    for (let i = 0; i < 800 && !out.some(m => m.params?.deltas?.some(d => d.kind === 'turn.boundary')); i++) await delay(10);
    assert.ok(out.some(m => m.params?.deltas?.some(d => d.kind === 'turn.boundary')));
    assert.deepEqual(readFileSync(join(setup.launch.env.HOME, 'bb-binding.json')), binding);
  }); } finally { await r.close(); rmSync(root, { recursive: true }); }
});
async function harness(r, fn) {
  const output = [], bridge = api.createZCodeBridge(r.services, m => output.push(m)); let n = 0;
  const rpc = async (method, params, error = false) => {
    const id = ++n; bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    for (let i = 0; i < 800; i++) { const m = output.find(m => m.id === id); if (m) { if (!error) assert.equal(m.error, undefined, JSON.stringify(m)); return m; } await delay(10); }
    throw Error('test RPC timeout');
  };
  try { await fn(rpc, output, bridge); } finally { await bridge.close(); await r.close(); }
}
test('actual prepare canonical identity, same-cwd separation, stable resume and clear; pre-auth conflicts/legacy/cwd', async () => {
  const { root, r, counts } = runtime(), cwd = root;
  try {
    for (const id of [undefined, { threadId: '' }, { threadId: ' ' }]) await assert.rejects(r.services.prepare(cwd, api.executionOptions(options), id), /identity/);
    await assert.rejects(r.services.prepare(cwd, api.executionOptions({ ...options, envVars: { BB_THREAD_ID: 'b' } }), { threadId: 'a' }), /conflict/);
    assert.deepEqual(counts(), { reads: 0, discoveries: 0 }); assert.equal(existsSync(r.root()), false);
    const a = await r.services.prepare(cwd, api.executionOptions({ ...options, instructions: 'A_PRIVATE' }), { threadId: 'a' }); a.bindSession('native-a');
    const b = await r.services.prepare(cwd, api.executionOptions({ ...options, instructions: 'B_PRIVATE' }), { threadId: 'b' }); b.bindSession('native-b');
    assert.equal(a.launch.env.ZCODE_STORAGE_DIR, b.launch.env.ZCODE_STORAGE_DIR, 'historical decision shared storage; only plugin registration/data use per-thread mode stores');
    assert.notEqual(a.launch.env.ZCODE_SESSION_DB_PATH, b.launch.env.ZCODE_SESSION_DB_PATH);
    assert.notEqual(a.launch.env.HOME, b.launch.env.HOME); assert.equal(a.launch.env.BB_THREAD_ID, 'a');
    assert.equal(readFileSync(join(a.launch.env.HOME, '.zcode/AGENTS.md'), 'utf8'), 'A_PRIVATE');
    const again = await r.services.prepare(cwd, api.executionOptions(options), { threadId: 'a', providerThreadId: 'native-a' });
    const alias = join(root, 'alias'); symlinkSync(root, alias);
    const aliased = await r.services.prepare(alias, api.executionOptions(options), { threadId: 'a', providerThreadId: 'native-a' });
    assert.equal(aliased.launch.cwd, root); assert.equal(aliased.launch.env.HOME, a.launch.env.HOME);
    const other = join(root, 'other'); mkdirSync(other);
    await assert.rejects(r.services.prepare(other, api.executionOptions(options), { threadId: 'a', providerThreadId: 'native-a' }), /binding/);
    assert.equal(again.launch.env.HOME, a.launch.env.HOME); assert.equal(existsSync(join(a.launch.env.HOME, '.zcode/AGENTS.md')), false);
    assert.equal(readFileSync(join(b.launch.env.HOME, '.zcode/AGENTS.md'), 'utf8'), 'B_PRIVATE');
    const before = counts();
    await assert.rejects(r.services.prepare('/different', api.executionOptions(options), { threadId: 'a', providerThreadId: 'native-a' }), /binding/);
    await assert.rejects(r.services.prepare(cwd, api.executionOptions(options), { threadId: 'a', providerThreadId: 'legacy' }), /legacy/);
    await assert.rejects(r.services.prepare(cwd, api.executionOptions(options), { threadId: 'new', providerThreadId: 'legacy' }), /legacy/);
    assert.deepEqual(counts(), before);
    await r.services.models(); // Synthetic child; service HOME and store separate.
    const homes = readdirSync(join(r.root(), 'catalogue-homes')).map(name => join(r.root(), 'catalogue-homes', name));
    assert.equal(homes.length, 1);
    assert.ok(existsSync(join(homes[0], 'fake-native-sessions.json')));
    assert.equal(existsSync(join(homes[0], '.zcode/AGENTS.md')), false);
    assert.ok(!homes.includes(a.launch.env.HOME) && !homes.includes(b.launch.env.HOME));
  }
  finally { await r.close(); rmSync(root, { recursive: true }); }
});
test('binding/HOME faults expose recovery action before auth or native startup and preserve original binding bytes', async () => {
  const { root, r, counts } = runtime();
  try {
    assert.throws(() => api.executionOptions({ ...options, envVars: { HOME: '/manual' } }), /remove the manual HOME override/);
    await assert.rejects(r.services.prepare(root, api.executionOptions(options)), /attach from the original bb thread/);
    const setup = await r.services.prepare(root, api.executionOptions(options), { threadId: 'own' });
    setup.bindSession('native-own'); const file = join(setup.launch.env.HOME, 'bb-binding.json');
    const before = counts(); writeFileSync(file, '{', 'utf8');
    await assert.rejects(r.services.prepare(root, api.executionOptions(options), { threadId: 'own', providerThreadId: 'native-own' }), /keep binding\/session\/history files.*reconcile/);
    assert.equal(readFileSync(file, 'utf8'), '{'); assert.deepEqual(counts(), before);
  } finally { await r.close(); rmSync(root, { recursive: true }); }
});
test('actual handleLine -> prepare: two threads; snapshot env clear/absent, instructions reattach, same-PID selection', async () => {
  const { root, r } = runtime();
  try { await harness(r, async (rpc, out, bridge) => {
    const start = threadId => ({ threadId, cwd: root, instructionMode: 'append', options: { ...options, instructions: 'OWN_' + threadId, envVars: { PATH: '/explicit', LANG: 'explicit-lang' } }, disallowedTools: [], dynamicTools: [] });
    const a = (await rpc('thread/start', start('a'))).result.providerThreadId;
    const b = (await rpc('thread/start', start('b'))).result.providerThreadId;
    const pids = bridge.ownedPids(); assert.equal(new Set(pids).size, 2);
    const turn = (id, native, o, text = 'hi') => ({ threadId: id, providerThreadId: native, clientRequestId: 'creq_2222222222', options: o, input: [{ type: 'text', text, mentions: [] }] });
    for (const [model, reasoningLevel] of [['GLM-5.3', 'max'], ['GLM-5.3-Flash', 'low'], ['GLM-5.3-Flash', 'high'], ['GLM-5.3', 'max']]) {
      const begin = out.length;
      await rpc('turn/start', turn('a', a, { ...start('a').options, model, reasoningLevel }));
      // ACK precedes the fixture frame. Compare retention only after this
      // turn's authoritative boundary, rather than racing launch replacement.
      for (let i = 0; i < 800 && !out.slice(begin).some(m => m.params?.deltas?.some(d => d.kind === 'turn.boundary')); i++) await delay(10);
      assert.ok(out.slice(begin).some(m => m.params?.deltas?.some(d => d.kind === 'turn.boundary')));
      assert.deepEqual(bridge.ownedPids(), pids);
    }
    assert.equal(out.filter(m => m.method === 'session/replaced').length, 0);
    await rpc('turn/start', turn('a', a, { ...options, envVars: {}, instructions: '' }));
    assert.equal(out.filter(m => m.method === 'session/replaced').length, 1);
    assert.equal(out.find(m => m.method === 'session/replaced').params.contextLost, false);
    const home = api.sessionHome(r.root(), root, 'a'); assert.equal(existsSync(join(home, '.zcode/AGENTS.md')), false);
    assert.equal(readFileSync(join(api.sessionHome(r.root(), root, 'b'), '.zcode/AGENTS.md'), 'utf8'), 'OWN_b');
    const stable = bridge.ownedPids(); await rpc('turn/start', turn('a', a, options)); assert.deepEqual(bridge.ownedPids(), stable);
    const conflict = await rpc('turn/start', turn('a', a, { ...options, envVars: { BB_THREAD_ID: 'b' } }), true); assert.ok(conflict.error);
    const missing = await rpc('thread/start', { ...start('c'), threadId: '' }, true); assert.ok(missing.error);
    assert.equal(bridge.ownedPids().length, 2); assert.ok(b);
  }); } finally { rmSync(root, { recursive: true }); }
});
test('F2 native-shaped zero-items before/after ACK and synthetic different/headerless messageId', async () => {
  const { root, r } = runtime();
  const timer = globalThis.setTimeout;
  // Accelerate only the production 60s unresolved/RPC clock in this isolated
  // test process; no product timeout setting or altered native response shape.
  globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 60_000 ? 250 : ms, ...args);
  try { await harness(r, async (rpc, out) => {
    const s = (await rpc('thread/start', { threadId: 'ack', cwd: root, instructionMode: 'append', options })).result.providerThreadId;
    for (const text of ['/clear', '/zero-before-ack', '/synthetic-different-message', '/synthetic-headerless']) {
      const begin = out.length;
      await rpc('turn/start', { threadId: 'ack', providerThreadId: s, clientRequestId: 'creq_2222222222', options, input: [{ type: 'text', text, mentions: [] }] }); await delay(text === '/synthetic-headerless' ? 300 : 80);
      const ds = out.slice(begin).flatMap(m => m.params?.deltas ?? []);
      assert.equal(ds.filter(d => d.kind === 'turn.boundary').length, text === '/synthetic-headerless' ? 0 : 1);
      assert.equal(JSON.stringify(ds).includes('synthetic-not-turn-id'), false);
      if (text === '/synthetic-headerless') assert.ok(out.slice(begin).some(m => m.method === 'error' && m.params.message.includes('unresolved')));
      if (text.startsWith('/zero') || text === '/clear') assert.equal(ds.filter(d => d.kind === 'item.open').length, 0);
    }
  }); } finally { globalThis.setTimeout = timer; rmSync(root, { recursive: true }); }
});
test('F3 sanitizer preserves unknown fields/relationships and full generic envelopes before adaptation', () => {
  const x = sanitizeEnvelope({ future: { x: 'private', repeated: 'private', empty: {}, list: [null, true, 12, 'private'] } });
  assert.equal(x.future.x, x.future.repeated); assert.equal(x.future.list[3], x.future.x); assert.deepEqual(x.future.empty, {});
  assert.equal(JSON.stringify(x).includes('private'), false); assert.throws(() => sanitizeEnvelope({ x: undefined }), /shape/);
  const fs = JSON.parse(readFileSync(new URL('./fixtures/bb-real-inputs.json', import.meta.url), 'utf8')).fixtures;
  for (const f of fs) {
    assert.deepEqual(Object.keys(f.genericRequest.params), f.provenance.originalParamFields);
    assert.deepEqual(Object.keys(f.genericRequest.params.options), f.provenance.originalOptionFields);
    assert.deepEqual(Object.keys(f.genericRequest.params.options.providerOptions ?? {}), f.provenance.originalProviderOptionFields);
    assert.notDeepEqual(f.genericRequest, f.request);
  }
});
