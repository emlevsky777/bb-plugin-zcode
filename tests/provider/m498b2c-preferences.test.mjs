import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api } from './helpers.mjs';
import { reportEvents } from '../../src/problem-report.ts';

const options = { permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null, model: 'GLM-5.3', reasoningLevel: 'high' };
test('Desktop memory boolean has priority; active steer retains it and ordinary rereads it without writes', async () => {
  const root = mkdtempSync('/tmp/m498b2c-'), settings = join(root, '.zcode/v2/setting.json'), file = join(root, 'sessions.json');
  mkdirSync(join(root, '.zcode/v2'), { recursive: true });
  const write = value => writeFileSync(settings, JSON.stringify(value));
  const children = [], out = [];
  const bridge = api.createZCodeBridge({ memoryEnabled: () => api.desktopMemoryEnabled(root),
    prepare: async () => ({ launch: { executable: process.execPath, args: [resolve('tests/provider/fake-v4.mjs'), 'v4', file], cwd: root, env: api.childEnvironment(process.env, {}) },
      auth: new api.ReadOnlyAuth(join(root, 'missing')), configure: async child => { children.push(child); } }),
    health: async () => ({}), installation: async () => ({}), models: async () => ({}), validateSelection: async () => {} }, m => out.push(m));
  let ordinal = 0;
  async function rpc(method, params) {
    const id = ++ordinal; bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    for (let i = 0; i < 1200; i++) { const r = out.find(m => m.id === id); if (r) { assert.ok(!r.error, JSON.stringify(r)); return r.result; } await delay(5); }
    throw Error('RPC timeout');
  }
  try {
    assert.equal(api.desktopMemoryEnabled(root), undefined);
    for (const value of [{}, { memoryEnabled: 'false' }, null]) { write(value); assert.equal(api.desktopMemoryEnabled(root), undefined); }
    writeFileSync(settings, '{'); assert.equal(api.desktopMemoryEnabled(root), undefined);
    write({ memoryEnabled: false, nativeSearchEnhancementsEnabled: false, askUserQuestionAutoResolutionEnabled: true });
    const { providerThreadId } = await rpc('thread/start', { threadId: 'desktop-memory', cwd: root, instructionMode: 'append', options: { ...options, providerOptions: { memoryEnabled: true } } });
    const state = () => JSON.parse(readFileSync(file, 'utf8'))[providerThreadId];
    async function preference(expected) {
      const before = { bytes: readFileSync(settings, 'utf8'), mtime: statSync(settings).mtimeMs };
      await children.at(-1).request('fixture/preferences', {});
      for (let i = 0; i < 500 && state().runtimePreferences?.memoryEnabled !== expected; i++) await delay(5);
      assert.equal(state().runtimePreferences.memoryEnabled, expected);
      assert.equal(state().runtimePreferences.nativeSearchEnhancementsEnabled, true);
      assert.equal(state().runtimePreferences.askUserQuestionAutoResolutionEnabled, false);
      assert.deepEqual({ bytes: readFileSync(settings, 'utf8'), mtime: statSync(settings).mtimeMs }, before);
    }
    await preference(false);
    const turn = { threadId: 'desktop-memory', providerThreadId, clientRequestId: 'creq_2222222222', options, input: [{ type: 'text', text: '/wait-for-interrupt' }] };
    await rpc('turn/start', turn);
    for (let i = 0; i < 500 && !out.some(m => m.params?.deltas?.some(d => d.kind === 'turn.open')); i++) await delay(5);
    assert.ok(out.some(m => m.params?.deltas?.some(d => d.kind === 'turn.open')), 'Native frame must reach the bridge before steer');
    write({ memoryEnabled: true });
    await rpc('turn/steer', { ...turn, expectedTurnId: state().rows.window.find(r => r.kind === 'turnHeader').turnId,
      clientRequestId: 'creq_3333333333', options: { ...options, providerOptions: { memoryEnabled: false } }, input: [{ type: 'text', text: 'guide' }] });
    await preference(false); await delay(180);
    await rpc('turn/start', { ...turn, clientRequestId: 'creq_4444444444', options: { ...options, providerOptions: { memoryEnabled: false } }, input: [{ type: 'text', text: 'ordinary' }] });
    await preference(true); await delay(80);
    write({ memoryEnabled: 'invalid' });
    await rpc('turn/start', { ...turn, clientRequestId: 'creq_5555555555', options: { ...options, providerOptions: { memoryEnabled: false } }, input: [{ type: 'text', text: 'fallback' }] });
    await preference(false);
  } finally { await bridge.close(); rmSync(root, { recursive: true }); }
});

test('MCP failures remain report diagnostics; ordinary is not blocked and no thread warning is returned', async () => {
  const root = mkdtempSync('/tmp/m498b2c-mcp-'), file = join(root, 'sessions.json'), out = [];
  const childState = { child: { exitCode: null, signalCode: null }, generation: 1 };
  const observe = event => appendFileSync(join(root, 'service-evidence.ndjson'), JSON.stringify(event) + '\n');
  const bridge = api.createZCodeBridge({ prepare: async () => ({
    launch: { executable: process.execPath, args: [resolve('tests/provider/fake-v4.mjs'), 'v4', file], cwd: root, env: api.childEnvironment(process.env, {}) },
    auth: new api.ReadOnlyAuth(join(root, 'missing')), configure: async () => {}, readySession: async (_, id) => {
      writeFileSync(join(root, 'mcp.jsonl'), [
        { event: 'mcp.startup.failed', sessionId: id },
        { event: 'mcp.startup.completed', sessionId: id, context: { serverCount: 2, statusCounts: { connected: 1, failed: 1 } } },
      ].map(JSON.stringify).join('\n'));
      assert.equal(await api.waitNativeMcpReady(root, childState, id, observe), undefined);
    } }), health: async () => ({}), installation: async () => ({}), models: async () => ({}), validateSelection: async () => {} }, m => out.push(m));
  let ordinal = 0;
  async function rpc(method, params) {
    const id = ++ordinal; bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    for (let i = 0; i < 1000; i++) { const r = out.find(m => m.id === id); if (r) { assert.ok(!r.error, JSON.stringify(r)); return r.result; } await delay(5); }
    throw Error('RPC timeout');
  }
  try {
    const { providerThreadId } = await rpc('thread/start', { threadId: 'mcp-diagnostics', cwd: root, instructionMode: 'append', options });
    await rpc('turn/start', { threadId: 'mcp-diagnostics', providerThreadId, options, clientRequestId: 'creq_2222222222', input: [{ type: 'text', text: 'ordinary' }] });
    await delay(100);
    assert.ok(reportEvents(root).includes('native-mcp-degraded'));
    assert.ok(reportEvents(root).includes('native-mcp-startup-observed'));
    assert.ok(!out.some(m => m.params?.deltas?.some(d => d.kind === 'provider.warning')));
    assert.ok(out.some(m => m.params?.deltas?.some(d => d.kind === 'turn.boundary')));
  } finally { await bridge.close(); rmSync(root, { recursive: true }); }
});

test('report includes asynchronous MCP failures from saved native logs, with no raw content', () => {
  const root = mkdtempSync('/tmp/m498b2c-report-'), logs = join(root, 'generations', 'own', 'logs');
  mkdirSync(logs, { recursive: true });
  try {
    writeFileSync(join(logs, 'native.jsonl'), JSON.stringify({ event: 'mcp.startup.completed', context: { statusCounts: { failed: 1 }, secret: 'SYNTHETIC_SECRET' } }) + '\n{incomplete');
    assert.deepEqual(reportEvents(root), ['native-mcp-degraded']);
    writeFileSync(join(logs, 'native.jsonl'), JSON.stringify({ event: 'mcp.startup.failed', context: { secret: 'SYNTHETIC_SECRET' } }));
    assert.deepEqual(reportEvents(root), ['native-mcp-degraded']);
    writeFileSync(join(logs, 'native.jsonl'), '{incomplete');
    assert.deepEqual(reportEvents(root), []);
  } finally { rmSync(root, { recursive: true }); }
});
