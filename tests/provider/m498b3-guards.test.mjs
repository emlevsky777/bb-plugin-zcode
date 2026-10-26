import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api, snapshot } from './helpers.mjs';
const options = { permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null, model: 'GLM-5.3', reasoningLevel: 'high' };

test('native config revision changes with installed builtin hint, no personal override/copies; shared files untouched', async () => {
  const root = mkdtempSync('/tmp/m498b3-config-'), builtin = join(root, 'builtin.json'), personal = join(root, 'personal.json');
  writeFileSync(builtin, '{}'); writeFileSync(personal, 'USER_SENTINEL');
  const auth = new api.ReadOnlyAuth(join(root, 'missing')); auth.read = () => ({ apiKey: 'SYNTHETIC_ONLY' });
  const rt = api.createNativeServices(join(root, 'bb'), { auth, discovery: () => ({ installed: true }), paths: { executable: process.execPath, script: resolve('tests/provider/fake-v4.mjs'), builtin } });
  try {
    for (const revision of ['normalized-native-v1', 'normalized-native-v2']) {
      writeFileSync(builtin, JSON.stringify({ revision }));
      const setup = await rt.services.prepare(root, api.executionOptions(options), { threadId: revision });
      assert.equal(setup.launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, builtin);
      for (const key of ['ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'ZCODE_DATA_BASE_DIR']) assert.equal(setup.launch.env[key], undefined);
      mkdirSync(setup.launch.env.ZCODE_LOG_DIR, { recursive: true });
      // Native registry ready observation: normalized revision differs from
      // the bundled JSON field, as in K-116; ACK alone proves no entitlement.
      writeFileSync(join(setup.launch.env.ZCODE_LOG_DIR, 'native.jsonl'), JSON.stringify({ context: { configRevision: JSON.stringify([revision, 'personal']), providerCount: 1 } }) + '\n');
      const calls = [], child = { child: { pid: 1 }, generation: 1, nativePid: 1, closed: Promise.resolve(), close: async () => 0, request: async (method, params) => { calls.push({ method, params }); return {}; } };
      await setup.configure(child);
      assert.equal(calls.find(c => c.method === 'provider/updateAccountConfig').params.basedOnZCodeBuiltinRevision, revision);
      assert.equal(existsSync(join(root, 'bb/data/zcode-builtin.json')), false);
      assert.equal(existsSync(join(root, 'bb/data/provider-config.json')), false);
      assert.equal(readFileSync(personal, 'utf8'), 'USER_SENTINEL');
      assert.equal(JSON.parse(readFileSync(builtin, 'utf8')).revision, revision);
    }
  } finally { await rt.close(); rmSync(root, { recursive: true }); }
});

test('background checkpoint exceeds old count/size, full command survives recovery, v1 is unsupported', () => {
  const root = mkdtempSync('/tmp/m498b3-background-'), file = join(root, 'tasks.json'), description = 'custom-executable --argument ' + 'x'.repeat(300);
  const tasks = Array.from({ length: 4097 }, (_, i) => ({ workId: String(i), key: JSON.stringify(['session1', 'background', String(i)]), closed: false, description }));
  try {
    writeFileSync(file, JSON.stringify({ version: 2, sessionId: 'session1', tasks }));
    assert.ok(Buffer.byteLength(readFileSync(file)) > 1024 * 1024);
    const bg = new api.BackgroundTasks('session1', () => {}, file);
    const recovered = bg.baseline({ ...snapshot(), backgroundWorks: [] });
    assert.equal(recovered.length, 4097); assert.ok(recovered[0].summary.includes(description));
    bg.recoveryDelivered();
    const command = '/own/new-program --full "native argument"';
    const s = snapshot([{ rowId: 1, kind: 'turnHeader', turnId: 'turn1', state: 'running' }, { rowId: 2, kind: 'toolCall', turnId: 'turn1', toolName: 'Bash', workId: 'new', input: { command }, status: 'success' }]);
    s.backgroundWorks = [{ workId: 'new', kind: 'bash', title: command, status: 'running', anchorRowId: 2 }];
    assert.equal(bg.project(s).find(d => d.kind === 'item.open').item.description, command);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).tasks.at(-1).description, command);
    assert.ok(new api.BackgroundTasks('session1', () => {}, file).baseline({ ...snapshot(), backgroundWorks: [] })[0].summary.includes(command));
    writeFileSync(file, JSON.stringify({ version: 1, sessionId: 'session1', tasks: [] }));
    assert.throws(() => new api.BackgroundTasks('session1', () => {}, file), /background-checkpoint-invalid/);
  } finally { rmSync(root, { recursive: true }); }
});

test('lifecycle exceeds old item/byte limits; compact exceeds lifetime limit and keeps deduplication', () => {
  const lifecycle = new api.SessionLifecycle('own', 'session1', 'epoch1', 1, () => {}, () => {}, async () => 0);
  for (let i = 0; i < 4097; i++) lifecycle.openWork({ kind: 'item.open', providerTurnId: 'turn1', key: { providerItemId: String(i) }, item: { type: 'backgroundTask', familyId: String(i), skipTranscript: false, taskType: 'bash', description: i ? 'own command' : 'x'.repeat(16 * 1024 * 1024 + 1), status: 'pending', taskStatus: 'running' } }, 1, 'session1');
  const compact = new api.CompactionProjection(() => {});
  for (let i = 0; i < 1025; i++) { compact.begin(String(i), 'request-' + i); compact.accept(String(i)); compact.settle('failed'); }
  assert.throws(() => compact.begin('next', 'request-0'), /Duplicate compact/);
  assert.throws(() => compact.begin('0', 'new-request'), /Duplicate compact/);
});

async function fixture(run) {
  const root = mkdtempSync('/tmp/m498b3-bridge-'), output = [], evidence = []; let child, ordinal = 0;
  const auth = new api.ReadOnlyAuth(join(root, 'missing'));
  const bridge = api.createZCodeBridge({ prepare: async () => ({ auth, launch: { executable: process.execPath, args: [resolve('tests/provider/fake-v4.mjs'), 'v4', join(root, 'sessions.json')], cwd: root, env: process.env }, configure: async c => { child = c; } }), observe: e => evidence.push(e), validateSelection: async () => {}, health: async () => ({}), installation: async () => ({}), models: async () => ({ models: [] }) }, m => output.push(m));
  async function rpc(method, params, expectError = false) {
    const id = ++ordinal; bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    for (let i = 0; i < 500; i++) { const response = output.find(m => m.id === id); if (response) { assert.equal(Boolean(response.error), expectError, JSON.stringify(response)); return expectError ? response.error : response.result; } await delay(5); }
    throw Error('RPC timeout');
  }
  try {
    const { providerThreadId } = await rpc('thread/start', { threadId: 'own', cwd: root, options, instructionMode: 'append' });
    await run({ root, child, auth, rpc, evidence, output, params: { threadId: 'own', providerThreadId, options }, deltas: () => output.flatMap(m => m.params?.deltas ?? []) });
  } finally { await bridge.close(); rmSync(root, { recursive: true }); }
}

test('unknown admission at fake 60s keeps process alive; late native frame settles once without resend', () => fixture(async f => {
  const timer = globalThis.setTimeout, clock = Date.now; let watchdog; const buffered = []; let sends = 0;
  const message = f.child.onMessage, request = f.child.request.bind(f.child);
  f.child.onMessage = (m, g) => m.method === 'v4/conversation/frame' ? buffered.push([m, g]) : message(m, g);
  f.child.request = (method, params) => { if (params?.type === 'sendText') sends++; return request(method, params); };
  globalThis.setTimeout = (fn, ms, ...args) => ms === 60_000 ? (watchdog ??= fn, { unref() {} }) : timer(fn, ms, ...args);
  try {
    await f.rpc('turn/start', { ...f.params, clientRequestId: 'creq_2222222222', input: [{ type: 'text', text: '/clear' }] });
    for (let i = 0; i < 500 && !buffered.some(([m]) => m.params.frame.payload.snapshot.rows.window.some(r => r.kind === 'turnHeader')); i++) await delay(5);
    assert.ok(buffered.some(([m]) => m.params.frame.payload.snapshot.rows.window.some(r => r.kind === 'turnHeader')));
    assert.ok(watchdog); Date.now = () => clock() + 60_001; watchdog(); Date.now = clock;
    assert.equal(f.child.child.exitCode, null); assert.equal(f.child.child.killed, false);
    assert.ok(f.output.some(m => m.method === 'error' && m.params.message.includes('remains available')));
    assert.equal(f.deltas().filter(d => d.kind === 'input.accepted').length, 0);
    for (const [m, g] of buffered) { message(m, g); message(m, g); }
    assert.equal(f.deltas().filter(d => d.kind === 'input.accepted').length, 1);
    assert.equal(f.deltas().filter(d => d.kind === 'turn.boundary').length, 1);
    assert.equal(sends, 1); assert.ok((await f.child.request('echo', { alive: true })).alive);
  } finally { globalThis.setTimeout = timer; Date.now = clock; }
}));

test('transport expiry without ACK retains RPC correlation; late ACK and admission do not kill or resend', () => fixture(async f => {
  const timer = globalThis.setTimeout, callbacks = [], request = f.child.request.bind(f.child); let sends = 0;
  f.child.request = (method, params) => { if (params?.type === 'sendText') sends++; return request(method, params); };
  globalThis.setTimeout = (fn, ms, ...args) => ms === 60_000 ? (callbacks.push(fn), { unref() {} }) : timer(fn, ms, ...args);
  try {
    const response = f.rpc('turn/start', { ...f.params, clientRequestId: 'creq_2222222222', input: [{ type: 'text', text: '/synthetic-delayed-ack' }] }, true);
    for (let i = 0; i < 100 && callbacks.length < 2; i++) await delay(1);
    assert.equal(callbacks.length, 2); callbacks[0](); callbacks[1]();
    assert.match((await response).message, /remains available/);
    for (let i = 0; i < 500 && !f.deltas().some(d => d.kind === 'turn.boundary'); i++) await delay(5);
    assert.equal(f.child.child.exitCode, null); assert.equal(f.child.child.killed, false); assert.equal(sends, 1);
    assert.equal(f.deltas().filter(d => d.kind === 'input.accepted').length, 1);
    assert.equal(f.deltas().filter(d => d.kind === 'turn.boundary').length, 1);
    assert.ok((await f.child.request('echo', { alive: true })).alive);
  } finally { globalThis.setTimeout = timer; }
}));

test('auth source changes both ways with background work; steer retains active source until ordinary', () => fixture(async f => {
  const message = f.child.onMessage;
  f.child.onMessage = (m, g) => {
    if (m.method === 'v4/conversation/frame') m.params.frame.payload.snapshot.backgroundWorks = [{ kind: 'bash', workId: 'background-own', title: 'sleep 60', status: 'running', anchorRowId: null }];
    message(m, g);
  };
  const next = { ...options, providerOptions: { authMode: 'coding-plan-key' } };
  await f.rpc('turn/start', { ...f.params, clientRequestId: 'creq_2222222222', input: [{ type: 'text', text: '/wait-for-interrupt' }] });
  await delay(30);
  const state = JSON.parse(readFileSync(join(f.root, 'sessions.json'), 'utf8'))[f.params.providerThreadId];
  const expectedTurnId = state.rows.window.find(r => r.kind === 'turnHeader').turnId;
  await f.rpc('turn/steer', { ...f.params, options: next, expectedTurnId, clientRequestId: 'creq_3333333333', input: [{ type: 'text', text: '/steer-lifetime' }] });
  assert.equal(f.evidence.find(e => e.event === 'steer-requested').authSource, 'cli'); assert.equal(f.auth.source(), 'cli');
  await f.child.request('fixture/complete', {});
  await f.rpc('turn/start', { ...f.params, options: next, clientRequestId: 'creq_4444444444', input: [{ type: 'text', text: '/clear' }] });
  assert.equal(f.auth.source(), 'coding-plan-key');
  await f.rpc('turn/start', { ...f.params, clientRequestId: 'creq_5555555555', input: [{ type: 'text', text: '/clear' }] });
  assert.equal(f.auth.source(), 'cli');
}));
