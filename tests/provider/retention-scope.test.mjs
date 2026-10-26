import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api } from './helpers.mjs';
// Native JSON member order is synthetic; not E2's exact raw difference.
for (const mutation of ['keys', 'clocks', 'text', 'unknown', 'array', 'identity'])
test('M1 actual bridge retention is diagnostic, not a pre-send gate: ' + mutation, async () => {
  const base = resolve(process.env.ZCODE_CONNECTION_TEST_ROOT ?? '.local/implementation-3.2.2.E/offline'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'retention-')), output = [], evidence = []; let generation = 0, ordinal = 0;
  const options = { permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null, instructions: 'synthetic X' };
  const bridge = api.createZCodeBridge({ prepare: async () => ({ launch: { executable: process.execPath, args: [resolve('tests/provider/fake-v4.mjs'), 'v4', join(root, 'sessions.json')], cwd: root, env: api.childEnvironment(process.env, { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }) }, auth: new api.ReadOnlyAuth(join(root, 'missing')), configure: async c => {
    const ownGeneration = ++generation;
    if (ownGeneration === 2 || mutation === 'clocks') {
      const original = c.onMessage;
      c.onMessage = (m, g) => {
        const rows = m.params?.frame?.payload?.snapshot?.rows;
        if (rows) {
          rows.window = rows.window.map(row => Object.fromEntries(Object.entries(row).reverse()));
          const row = rows.window.find(r => r.kind === 'assistantText');
          if (row && mutation === 'text') row.text += 'changed';
          if (row && mutation === 'unknown') row.future = { changed: true };
          if (row && mutation === 'array') row.future = [2, 1];
          if (row && mutation === 'identity') row.rowId += 100;
          if (mutation === 'clocks') for (const r of rows.window) { r.createdAt = ownGeneration === 2 ? 200 : 100; r.createdAtSeq = ownGeneration === 2 ? 99 : 1; }
        }
        original(m, g);
      };
    }
    await c.request('runtime/capabilities', {});
  } }), validateSelection: async () => {}, observe: e => evidence.push(e) }, m => output.push(m));
  async function rpc(method, params) {
    const id = ++ordinal; bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    for (let i = 0; i < 500; i++) { const m = output.find(m => m.id === id); if (m) return m; await delay(10); }
    throw Error('Synthetic RPC timeout');
  }
  try {
    const s = await rpc('thread/start', { threadId: 'own', cwd: root, options, instructionMode: 'append' }); assert.ok(s.result);
    const turn = { threadId: 'own', providerThreadId: s.result.providerThreadId, clientRequestId: 'creq_2222222222', options, input: [{ type: 'text', text: 'hello', mentions: [] }] };
    assert.ok((await rpc('turn/start', turn)).result);
    for (let i = 0; i < 200 && !output.some(m => m.params?.deltas?.some(d => d.kind === 'turn.boundary')); i++) await delay(10);
    const next = await rpc('turn/start', { ...turn, options: { ...options, envVars: { BB_RETENTION_FIXTURE: 'next' } } });
    const preserved = ['keys', 'clocks'].includes(mutation);
    assert.ok(next.result, JSON.stringify(next));
    const retention = evidence.find(e => e.event === 'replacement-retention'); assert.equal(retention.retained, preserved); assert.equal(retention.beforeRows, retention.afterRows);
    const states = evidence.filter(e => e.event === 'native-state');
    const after = states.find(s => s.generation === 2).rows, before = states.filter(s => s.generation === 1).at(-1).rows;
    if (mutation !== 'identity' && !preserved) assert.deepEqual(after, before, 'sanitized structural equality alone is insufficient');
    assert.equal(output.filter(m => m.method === 'session/replaced').length, 1);
  } finally { await bridge.close(); rmSync(root, { recursive: true }); }
});
