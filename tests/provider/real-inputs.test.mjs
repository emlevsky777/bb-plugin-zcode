import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api } from './helpers.mjs';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/bb-real-inputs.json', import.meta.url), 'utf8')).fixtures;
const options = fixtures[0].request.params.options;
test('session data path stable for same bb thread, separate for other threads; history survives process generations', () => {
  const a = api.sessionDataDir('/own', '/workspace', 'thread-a');
  assert.equal(a, api.sessionDataDir('/own', '/workspace', 'thread-a'));
  assert.notEqual(a, api.sessionDataDir('/own', '/workspace', 'thread-b'));
  assert.equal(a, api.sessionDataDir('/own', '/other', 'thread-a'));
  assert.ok(a.startsWith('/own/sessions/'));
});
test('ADR022 explicit field dispositions, empty containers and poisoned inheritance', () => {
  const x = api.executionOptions(options);
  assert.doesNotThrow(() => api.executionOptions({ permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null }));
  assert.doesNotThrow(() => api.executionOptions({ ...options, providerOptions: { additionalWorkspaceWriteRoots: ['/fixture/root'] } }));
  for (const roots of ['bad', ['relative'], [3]]) assert.throws(() => api.executionOptions({ ...options, providerOptions: { additionalWorkspaceWriteRoots: roots } }));
  assert.equal(x.envVars.BB_THREAD_ID, 'fixture-thread');
  assert.equal(x.instructions, options.instructions);
  assert.doesNotThrow(() => api.executionOptions({ ...options, instructions: '', envVars: {}, providerOptions: {} }, 'replace', []));
  for (const extra of [{ promptMode: 'plan' }, { serviceTier: 'fast' }, { providerOptions: { hidden: true } },
    { approvalReviewer: 'automatic' }, { permissionEscalation: 'ask' }, { permissionScope: 'workspace' },
 { envVars: { INVALID: 3 } }])
    assert.throws(() => api.executionOptions({ ...options, ...extra }));
  assert.throws(() => api.executionOptions(options, 'replace'), /replacement/);
  assert.deepEqual(api.executionOptions(options, 'append', ['Bash']).toolDenylist, ['Bash']);
  const env = { ...api.childEnvironment({ PATH: '/parent', ANTHROPIC_BASE_URL: 'https://poison.invalid', SECRET: 'SYNTHETIC_SECRET' }, { HOME: '/own' }), ...x.envVars };
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://poison.invalid'); assert.equal(env.SECRET, 'SYNTHETIC_SECRET'); assert.equal(env.PATH, '/fixture/bin');
});
test('genuine codex/claude start resume turn forms work; no dynamic warning; replacement keeps native identity', async () => {
  const base = resolve(process.env.ZCODE_CONNECTION_TEST_ROOT ?? '.local/implementation-3.2.2.C/offline'); mkdirSync(base, { recursive: true });
  const cwd = mkdtempSync(base + '/forms-'), output = [], prepared = [];
  const services = { prepare: async (cwd, execution) => {
    prepared.push(execution);
    return { launch: { executable: process.execPath, args: [resolve('tests/provider/fake-v4.mjs'), 'v4', cwd + '/sessions.json'], cwd, env: api.childEnvironment(process.env, { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }) },
      auth: new api.ReadOnlyAuth(cwd + '/missing'), configure: async c => c.request('runtime/capabilities', {}) };
  }, health: async () => ({}), installation: async () => ({}), models: async () => ({}), validateSelection: async () => {} };
  const bridge = api.createZCodeBridge(services, m => output.push(m)); let ordinal = 0;
  async function rpc(method, params) {
    const id = ++ordinal; bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    for (let n = 0; n < 800; n++) { const response = output.find(m => m.id === id); if (response) { assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result; } await delay(10); }
    throw Error('RPC timed out');
  }
  try {
    for (const provider of ['codex', 'claude-code']) {
      const find = method => structuredClone(fixtures.find(f => f.provenance.provider === provider && f.request.method === method).request.params);
      const start = find('thread/start'); start.cwd = cwd; start.threadId = provider;
      start.options.envVars.BB_THREAD_ID = provider;
      const identity = await rpc('thread/start', start);
      const turn = find('turn/start'); Object.assign(turn, { threadId: provider, providerThreadId: identity.providerThreadId });
      turn.options.envVars.BB_THREAD_ID = provider;
      await rpc('turn/start', turn);
      assert.equal(prepared.at(-1).envVars.BB_THREAD_ID, provider);
      const replacements = output.filter(m => m.method === 'session/replaced' && m.params.threadId === provider).length;
      turn.options.model = 'GLM-5.3-Flash'; turn.options.reasoningLevel = 'low';
      await rpc('turn/start', turn);
      assert.equal(output.filter(m => m.method === 'session/replaced' && m.params.threadId === provider).length, replacements);
      assert.equal(prepared.at(-1).model, 'GLM-5.3');
      await rpc('thread/stop', { threadId: provider, providerThreadId: identity.providerThreadId, intent: 'release', activeTurnId: null });
      const resume = find('thread/resume'); Object.assign(resume, { cwd, threadId: provider, providerThreadId: identity.providerThreadId });
      resume.options.envVars.BB_THREAD_ID = provider;
      await rpc('thread/resume', resume);
      assert.equal(output.some(m => m.params?.deltas?.some(d => d.kind === 'provider.warning' && d.summary.includes('dynamicTools'))), false);
      await rpc('thread/discard', { threadId: provider, providerThreadId: identity.providerThreadId });
    }
    assert.deepEqual(bridge.ownedPids(), []);
  } finally { await bridge.close(); rmSync(cwd, { recursive: true }); }
});
