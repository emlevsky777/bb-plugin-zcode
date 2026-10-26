import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api, host, plugin, artifact } from './helpers.mjs';
import { experimental_runBridgeConformance, experimental_formatConformanceReport } from '@get-bb/plugin-sdk/provider-bridge/testing';
import { bridgeErrorDataSchema, threadDeltaSchema, providerRecoveryNotificationSchema } from '@get-bb/plugin-sdk/provider-bridge';
const base = resolve(process.env.ZCODE_CONNECTION_TEST_ROOT ?? '.local/implementation-3.2.2/offline'); mkdirSync(base, { recursive: true, mode: 0o700 });
const root = () => mkdtempSync(base + '/offline-');
const launch = (cwd, mode = 'v4', file) => ({ executable: process.execPath, args: [resolve('tests/provider/fake-v4.mjs'), mode, ...(file ? [file] : [])], cwd,
  env: api.childEnvironment(process.env, { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }) });
function fakeServices(cwd) {
  return { prepare: async () => ({ launch: launch(cwd, 'v4', cwd + '/sessions.json'), auth: new api.ReadOnlyAuth(cwd + '/missing'), configure: async p => { await p.request('runtime/capabilities', {}); } }),
    health: async () => ({}), installation: async () => ({}), models: async () => ({ models: [] }), validateSelection: async () => {} };
}
const recorded = JSON.parse(readFileSync(new URL('./fixtures/bb-real-inputs.json', import.meta.url), 'utf8')).fixtures;
const options = { ...recorded[0].request.params.options, envVars: {} };
test('public host imports and registration declare only the connected scope without starting native', async () => {
  assert.equal(host.experimental_host.experimental_apiVersion, 1); assert.equal(typeof host.handleLine, 'function');
  const calls = []; await plugin({ settings: { define: () => ({get:async()=>({authMode:'cli',catalogueRefresh:0}),onChange:()=>{}}) }, providers: { register: value => calls.push(value) } });
  assert.equal(calls[0].displayName, 'ZCode'); assert.deepEqual(calls[0].capabilities.permissionModes, ['full']);
  assert.deepEqual(calls[0].models, { scope: 'host' }); assert.ok(calls[0].capabilities.reasoningLevels.includes('medium'));
  assert.equal(api.bridgeCapabilities.approvalEnforcedBy, 'provider');
});
test('B17 real product handleLine with supervised fake V4 child passes public canonical conformance', async () => {
  const cwd = root(), output = [], bridge = host.createZCodeBridge(fakeServices(cwd), m => output.push(m)); let drained = 0;
  try {
    const report = await experimental_runBridgeConformance({ providerId: 'zcode', transport: { send: line => {
      let m; try { m = JSON.parse(line); } catch { bridge.handleLine(line); return; }
      if (['thread/start', 'thread/resume'].includes(m.method)) {
        m.params.dynamicTools = recorded[0].request.params.dynamicTools; m.params.disallowedTools = [];
      }
      bridge.handleLine(JSON.stringify(m));
    },
      takeMessages: () => { const fresh = output.slice(drained); drained = output.length; return fresh; }, close: () => bridge.close() },
      session: { cwd, promptInput: [{ type: 'text', text: 'say hello', mentions: [] }], zeroWorkPromptInput: [{ type: 'text', text: '/clear', mentions: [] }],
        interruptiblePromptInput: [{ type: 'text', text: '/wait-for-interrupt', mentions: [] }], options }, timeoutMs: 8000 });
    writeFileSync(base + `/conformance-${artifact ? 'artifact' : 'source'}.json`, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(experimental_formatConformanceReport(report));
    assert.equal(report.passed, true); assert.deepEqual(report.results.filter(r => r.status !== 'pass'), []);
  } finally { await bridge.close(); rmSync(cwd, { recursive: true }); }
});
test('ADR015 read-only fresh auth, empty/corrupt/cipher/identity/key change and unsupported mode', () => {
  const cwd = root(), file = cwd + '/credentials.json', a = new api.ReadOnlyAuth(file, Buffer.alloc(32));
  const store = (identity, key) => ({ [`account-provider:${api.accountProviderId}:auth-source`]: 'manual', [`account-provider:${api.accountProviderId}:identity`]: identity,
    [`account-provider:coding-plan:${api.accountProviderId}:account:${encodeURIComponent(identity)}:api-key`]: key });
  try {
    assert.throws(() => a.read(), /unauthenticated/); writeFileSync(file, '{}'); assert.throws(() => a.read(), /unauthenticated/);
    writeFileSync(file, '{'); assert.throws(() => a.read(), /invalid-store/);
    writeFileSync(file, JSON.stringify(store('test identity', 'SYNTHETIC_SECRET_1'))); const bytes = readFileSync(file); assert.equal(a.read().apiKey, 'SYNTHETIC_SECRET_1'); assert.deepEqual(readFileSync(file), bytes);
    writeFileSync(file, JSON.stringify(store('new identity', 'SYNTHETIC_SECRET_2'))); assert.equal(a.read().apiKey, 'SYNTHETIC_SECRET_2'); assert.equal(a.generation, 2);
    const request = { providerId: api.accountProviderId, accountAccess: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai', entitled: true },
      modelSelection: { providerId: api.accountProviderId, modelId: 'GLM-5.3' }, sessionId: 's', reason: 'model-request', requestId: 'r',
      workspace: { workspacePath: 'w', workspaceKey: 'w' } };
    assert.equal(a.headers(request, 's', 'w', 'GLM-5.3').requestAuth.apiKey, 'SYNTHETIC_SECRET_2');
    writeFileSync(file, JSON.stringify(store('next identity', 'SYNTHETIC_SECRET_3')));
    assert.equal(a.headers({ ...request, requestId: 'next' }, 's', 'w', 'GLM-5.3').requestAuth.apiKey, 'SYNTHETIC_SECRET_3');
    assert.equal(a.generation, 4);
    assert.equal(JSON.stringify(a).includes('SYNTHETIC_SECRET'), false);
    const encrypt = text => { const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32), Buffer.alloc(12, 7));
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return 'enc:v1:' + [Buffer.alloc(12, 7), cipher.getAuthTag(), data].map(v => v.toString('base64url')).join('.'); };
    const encrypted = { [`account-provider:${api.accountProviderId}:auth-source`]: encrypt('manual'), [`account-provider:${api.accountProviderId}:identity`]: encrypt('encrypted identity'),
      [`account-provider:coding-plan:${api.accountProviderId}:account:${encodeURIComponent('encrypted identity')}:api-key`]: encrypt('SYNTHETIC_SECRET_ENCRYPTED') };
    writeFileSync(file, JSON.stringify(encrypted)); const encryptedBytes = readFileSync(file);
    assert.equal(a.read().apiKey, 'SYNTHETIC_SECRET_ENCRYPTED'); assert.deepEqual(readFileSync(file), encryptedBytes);
    assert.throws(() => a.headers({ providerId: api.accountProviderId, accountAccess: { type: 'zhipu-account', mode: 'other' }, modelSelection: {}, workspace: {} }, 's', 'w', 'GLM-5.3'), /unsupported-mode/);
    writeFileSync(file, JSON.stringify(store('enc:v1:bad', 'key'))); assert.throws(() => a.read(), /invalid-store/);
    assert.equal(bridgeErrorDataSchema.parse({ recovery: api.authRecovery().recovery }).recovery.kind, 'authRequired');
    providerRecoveryNotificationSchema.parse({ threadId: 'own', kind: 'authRequired', message: 'login', retryable: false });
    threadDeltaSchema.parse({ kind: 'provider.error', category: 'unauthorized', message: 'login' });
  } finally { rmSync(cwd, { recursive: true }); }
});
test('K120 allowlist follows SDK sanitation; recording projection cannot retain synthetic auth', () => {
  const env = api.childEnvironment({ PATH: '/safe', ANTHROPIC_BASE_URL: 'https://poison.invalid', BB_PROVIDER_BRIDGE_RECORD_DIR: '/other', SECRET: 'SYNTHETIC_SECRET' }, { HOME: '/own' });
  assert.deepEqual(env, { PATH: '/safe', HOME: '/own', ANTHROPIC_BASE_URL: 'https://poison.invalid', SECRET: 'SYNTHETIC_SECRET' });
  for (const v of [{ id: 1, result: { requestAuth: { apiKey: 'SYNTHETIC_SECRET' } } }, { method: 'echo', params: { secret: 'SYNTHETIC_SECRET' } }, { error: { code: 401, message: 'SYNTHETIC_SECRET' } }]) assert.equal(api.recordingProjection(v).includes('SYNTHETIC_SECRET'), false);
});
test('B06 crash rejects pending on exit, close finalization and B15 safe bounded exit tail', async () => {
  const cwd = root(), deaths = [], p = new api.NativeProcess(launch(cwd, 'crash'), 2, 'own', () => {}, (e, g) => deaths.push({ e, g }));
  try { await assert.rejects(p.request('hang', {}), /exited|closed/); await p.closed; assert.equal(await p.close(), 0);
    assert.equal(deaths.length, 1); assert.equal(deaths[0].g, 2); assert.match(deaths[0].e.message, /redacted native stderr/); assert.doesNotMatch(deaths[0].e.message, /SYNTHETIC_SECRET/);
  } finally { await p.close(); rmSync(cwd, { recursive: true }); }
});
test('B06 hang uses EOF1s TERM4s KILL; late callbacks cannot enter a new generation', async () => {
  const cwd = root(), values = [], p = new api.NativeProcess(launch(cwd, 'hang'), 3, 'own', (m,g) => values.push(g), () => {});
  try { await delay(80); const start = Date.now(); assert.equal(await p.close(), 0); assert.ok(Date.now() - start >= 4900); assert.deepEqual(values, []);
    assert.throws(() => process.kill(p.child.pid, 0));
  } finally { await p.close(); rmSync(cwd, { recursive: true }); }
});
test('B06 request timeout rejects without retry and B07 missing executable classified', async () => {
  const cwd = root(), p = new api.NativeProcess(launch(cwd, 'hang'), 4, null, () => {}, () => {}, 80);
  try { await assert.rejects(p.request('unanswered', {}), /timeout.*unknown/); }
  finally { await p.close(); rmSync(cwd, { recursive: true }); }
  const q = new api.NativeProcess({ executable: '/missing-zcode-executable', args: [], cwd: base, env: {} }, 5, null, () => {}, () => {});
  await assert.rejects(q.request('x', {}), e => e.code === -32004); await q.closed; assert.equal(await q.close(), 0);
});
async function rpcHarness(services, fn) {
  const output = [], bridge = api.createZCodeBridge(services, m => output.push(m)); let ordinal = 0;
  const rpc = async (method, params) => {
    const id = ++ordinal; bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    for (let n = 0; n < 500; n++) { const response = output.find(m => m.id === id); if (response) return response; await delay(10); }
    throw Error('test RPC timeout');
  };
  try { await fn(rpc, output, bridge); } finally { await bridge.close(); }
}
test('N2 active release closes as failed before result, no interrupted, child group absent', async () => {
  const cwd = root();
  try { await rpcHarness(fakeServices(cwd), async (rpc, output, bridge) => {
    const start = await rpc('thread/start', { threadId: 'own', cwd, options, instructionMode: 'append' }); assert.ok(start.result);
    const providerThreadId = start.result.providerThreadId;
    await rpc('turn/start', { threadId: 'own', providerThreadId, options, clientRequestId: 'creq_2222222222', input: [{ type: 'text', text: '/wait-for-interrupt', mentions: [] }] });
    await delay(20); const pids = bridge.ownedPids();
    const stop = await rpc('thread/stop', { threadId: 'own', providerThreadId, intent: 'release', activeTurnId: null }); assert.ok(stop.result);
    const before = output.slice(0, output.indexOf(stop));
    const boundaries = before.flatMap(m => m.params?.deltas ?? []).filter(d => d.kind === 'turn.boundary');
    assert.equal(boundaries.length, 1); assert.equal(boundaries[0].status, 'failed');
    assert.equal(output.some(m => m.params?.deltas?.some(d => d.status === 'interrupted')), false);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0));
  }); } finally { rmSync(cwd, { recursive: true }); }
});
test('B08 request rejection uses typed authRequired alone; B07 launch rejection uses -32004', async () => {
  const cwd = root();
  try {
    const services = fakeServices(cwd); services.validateSelection = async () => { throw new api.AuthError('unauthenticated'); };
    await rpcHarness(services, async (rpc, output) => {
      const response = await rpc('thread/start', { threadId: 'own', cwd, options, instructionMode: 'append' });
      assert.equal(response.error.data.recovery.kind, 'authRequired'); assert.equal(output.filter(m => m.method === 'provider/recovery').length, 0);
    });
    const missing = fakeServices(cwd); missing.prepare = async () => ({ launch: { executable: '/missing-zcode', args: [], cwd, env: {} }, auth: new api.ReadOnlyAuth(cwd + '/missing'), configure: async child => { await child.request('runtime/capabilities', {}); } });
    await rpcHarness(missing, async rpc => { const response = await rpc('thread/start', { threadId: 'own', cwd, options, instructionMode: 'append' }); assert.equal(response.error.code, -32004); });
  } finally { rmSync(cwd, { recursive: true }); }
});
test('B08 midturn auth loss emits notification and unauthorized delta with no error.data recovery', async () => {
  const cwd = root(), services = fakeServices(cwd);
  services.models = async () => ({ models: [{ model: 'GLM-5.3' }] }); // admitted fixture model; auth loss is the variable under test
  services.prepare = async () => ({ launch: launch(cwd, 'v4', cwd + '/sessions.json'), auth: new api.ReadOnlyAuth(cwd + '/missing'), configure: async child => { await child.request('runtime/capabilities', {}); setTimeout(() => { void child.request('auth-bad', {}).catch(() => {}); }, 100); } });
  try { await rpcHarness(services, async (rpc, output) => {
    const start = await rpc('thread/start', { threadId: 'own', cwd, options, instructionMode: 'append' }); assert.ok(start.result);
    await rpc('turn/start', { threadId: 'own', providerThreadId: start.result.providerThreadId, options,
      clientRequestId: 'creq_2222222222', input: [{ type: 'text', text: '/wait-for-interrupt', mentions: [] }] });
    await delay(200);
    const recovery = output.filter(m => m.method === 'provider/recovery'); assert.equal(recovery.length, 1);
    providerRecoveryNotificationSchema.parse(recovery[0].params);
    assert.equal(output.flatMap(m => m.params?.deltas ?? []).filter(d => d.kind === 'provider.error' && d.category === 'unauthorized').length, 1);
    assert.equal(output.some(m => m.error?.data?.recovery), false);
  }); } finally { rmSync(cwd, { recursive: true }); }
});
for (const [providerId, mode, accountType, label] of [
  ['account:zai-start-plan', 'start-plan', 'zai', 'Start Plan'],
  ['account:zai-team-coding-plan', 'team-coding-plan', 'zai', 'Team Coding Plan'],
  ['account:zai-individual-coding-plan', 'off-peak', 'zai', 'off-peak'],
  ['account:bigmodel-individual-coding-plan', 'individual-coding-plan', 'bigmodel', 'BigModel'],
]) test(`M493 native unsupported ${label} emits bad-request and thread remains usable`, async () => {
  const cwd = root(), services = fakeServices(cwd); let child;
  services.models = async () => ({ models: [{ model: 'GLM-5.3' }] });
  services.prepare = async () => ({ launch: launch(cwd, 'v4', cwd + '/sessions.json'), auth: new api.ReadOnlyAuth(cwd + '/missing'), configure: async p => { child = p; await p.request('runtime/capabilities', {}); } });
  try { await rpcHarness(services, async (rpc, output) => {
    const start = await rpc('thread/start', { threadId: 'own', cwd, options, instructionMode: 'append' }); assert.ok(start.result);
    await child.request('auth-bad', { fixture: { providerId, accountAccess: { type: 'zhipu-account', mode, accountType, entitled: true }, modelSelection: { providerId, modelId: 'GLM-5.3' } } });
    await delay(100);
    const errors = output.flatMap(m => m.params?.deltas ?? []).filter(d => d.kind === 'provider.error');
    assert.equal(errors.length, 1); assert.equal(errors[0].category, 'bad-request'); assert.ok(errors[0].message.includes(label));
    assert.match(errors[0].message, /only the individual Coding Plan from Z.ai/);
    assert.equal(output.some(m => m.method === 'provider/recovery'), false);
    const turn = await rpc('turn/start', { threadId: 'own', providerThreadId: start.result.providerThreadId, options, clientRequestId: 'creq_2222222222', input: [{ type: 'text', text: 'ordinary next turn', mentions: [] }] }); assert.ok(turn.result);
  }); } finally { rmSync(cwd, { recursive: true }); }
});
test('B16 recorder is installed immediately, receives safe streams and no raw synthetic secret', async () => {
  const cwd = root(), recorded = [], calls = [];
  const recorder = (streams, scope) => { calls.push(scope); streams.stdin.on('data', b => recorded.push(String(b))); streams.stdout.on('data', b => recorded.push(String(b))); };
  const p = new api.NativeProcess(launch(cwd), 6, 'own', () => {}, () => {}, 60000, recorder);
  try { assert.deepEqual(calls, [{ threadId: 'own' }]);
    assert.deepEqual(await p.request('echo', { apiKey: 'SYNTHETIC_SECRET', requestAuth: { apiKey: 'SYNTHETIC_SECRET' } }), { apiKey: 'SYNTHETIC_SECRET', requestAuth: { apiKey: 'SYNTHETIC_SECRET' } });
    assert.ok(recorded.length >= 2); assert.doesNotMatch(recorded.join(''), /SYNTHETIC_SECRET/);
  } finally { assert.equal(await p.close(), 0); rmSync(cwd, { recursive: true }); }
});
test('B06 exit grace kills own pipe-holding descendants and finalizes on close', async () => {
  const cwd = root(), p = new api.NativeProcess(launch(cwd, 'descendant'), 7, 'own', () => {}, () => {});
  try { await p.closed; assert.equal(await p.close(), 0); assert.throws(() => process.kill(-p.child.pid, 0)); }
  finally { await p.close(); rmSync(cwd, { recursive: true }); }
});
test('B06 actual EPIPE from fake child closed fd0 immediately kills owned group', async () => {
  let ready = false;
  const cwd = root(), p = new api.NativeProcess(launch(cwd, 'epipe'), 8, 'own', m => { ready ||= m.method === 'fixture/epipe-ready'; }, () => {});
  try { for (let i = 0; i < 200 && !ready; i++) await delay(10); assert.ok(ready); const start = Date.now();
    await assert.rejects(p.request('echo', {}), /stdin failed|exited|closed/);
    await p.closed; assert.equal(await p.close(), 0); assert.ok(Date.now() - start < 1000);
  } finally { await p.close(); rmSync(cwd, { recursive: true }); }
});
test('B16 unknown method/id strings cannot smuggle secrets into safe recording', () => {
  assert.doesNotMatch(api.recordingProjection({ id: 'SYNTHETIC_SECRET', method: 'SYNTHETIC_SECRET', params: {} }), /SYNTHETIC_SECRET/);
});
test('bb model/list includes mandatory selectedOnlyModels carrier', async () => {
  const cwd = root();
  try { await rpcHarness(fakeServices(cwd), async rpc => {
    const response = await rpc('model/list', { cwd }); assert.deepEqual(response.result, { models: [], selectedOnlyModels: [] });
  }); } finally { rmSync(cwd, { recursive: true }); }
});
test('ADR016 maps real catalogue fields without fallback models or invented reasoning', () => {
  const available = ['GLM-5.3', 'GLM-5.3-Flash'].map(modelId => ({ ref: { providerId: api.accountProviderId, modelId },
    reasoning: { defaultLevel: 'max', levels: ['low', 'high', 'max'].map(value => ({ value })) } }));
  const mapped = api.mapNativeModels(available); assert.equal(mapped[0].isDefault, true); assert.equal(mapped[1].isDefault, false);
  assert.deepEqual(mapped.map(m => m.defaultReasoningEffort), ['max', 'max']);
  assert.equal(api.mapNativeModels(available.slice(1), { providerId: api.accountProviderId, modelId: 'GLM-5.3-Flash' })[0].isDefault, true);
  const poisoned = structuredClone(available); poisoned[0].reasoning.levels.push({ value: 'medium' });
  assert.equal(api.mapNativeModels(poisoned)[0].supportedReasoningEfforts.at(-1).reasoningEffort, 'medium');
});
