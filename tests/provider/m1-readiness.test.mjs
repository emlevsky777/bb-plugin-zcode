import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api } from './helpers.mjs';
// Shape: pinned core/runtime/methods/mcp.ts; own M1 scheduled/completed logs.
test('M1 actual readiness reader observes optional own-session logs without a readiness gate; rejects dead startup', async () => {
  const base = resolve(process.env.ZCODE_CONNECTION_TEST_ROOT ?? '.local/M1/offline'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'mcp-ready-')), file = join(root, 'fresh.jsonl');
  const child = { child: { exitCode: null, signalCode: null, pid: 123 }, generation: 2 }, events = [];
  const event = (sessionId, type, context) => JSON.stringify({ sessionId, event: type, context }) + '\n';
  try {
    writeFileSync(file, event('other', 'mcp.startup.completed', { serverCount: 1, statusCounts: { connected: 1 } }) + event('own', 'mcp.startup.scheduled', { serverCount: 1 }), 'utf8');
    await api.waitNativeMcpReady(root, child, 'own', e => events.push(e), 500);
    assert.equal(events[0].event, 'native-mcp-pending');
    events.length = 0;
    writeFileSync(file, event('own', 'mcp.startup.completed', { serverCount: 1, statusCounts: { connected: 1 }, toolCount: 1 }), 'utf8');
    await api.waitNativeMcpReady(root, child, 'own', e => events.push(e)); assert.equal(events.length, 1); assert.equal(events[0].sessionId, 'own');
    writeFileSync(file, event('own', 'mcp.startup.completed', { serverCount: 2, statusCounts: { failed: 1, connected: 1 }, toolCount: 1 }), 'utf8');
    assert.equal(await api.waitNativeMcpReady(root, child, 'own', e => events.push(e), 50), undefined);
    assert.equal(events.at(-2).failed, 1);
    assert.equal(events.at(-1).event, 'native-mcp-degraded');
    for (const context of [{}, { serverCount: 1, statusCounts: {} }, { serverCount: 1, statusCounts: { connected: 1, error: 1 } }]) {
      writeFileSync(file, event('own', 'mcp.startup.completed', context), 'utf8');
      await api.waitNativeMcpReady(root, child, 'own', () => {}, 50);
    }
    writeFileSync(file, event('own', 'mcp.startup.failed', {}), 'utf8');
    assert.equal(await api.waitNativeMcpReady(root, child, 'own', e => events.push(e), 50), undefined);
    assert.ok(events.some(e => e.event === 'native-mcp-degraded'));
    writeFileSync(file, event('other', 'mcp.startup.completed', { serverCount: 1, statusCounts: { connected: 1 } }), 'utf8');
    assert.equal(await api.waitNativeMcpReady(root, child, 'own', () => {}, 30), undefined);
    await api.waitNativeMcpReady(join(root, 'missing'), child, 'own', () => {});
    child.child.exitCode = 1;
    await assert.rejects(api.waitNativeMcpReady(root, child, 'own', () => {}, 30), /died/);
  } finally { rmSync(root, { recursive: true }); }
});
