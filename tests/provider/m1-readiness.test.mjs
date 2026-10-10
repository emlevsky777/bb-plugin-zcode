import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api } from './helpers.mjs';
// Shape: pinned core/runtime/methods/mcp.ts; own M1 scheduled/completed logs.
test('M1 actual readiness reader waits for own session completion; rejects failed/unknown/dead/timed-out startup', async () => {
  const base = resolve(process.env.ZCODE_CONNECTION_TEST_ROOT ?? '.local/M1/offline'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'mcp-ready-')), file = join(root, 'fresh.jsonl');
  const child = { child: { exitCode: null, signalCode: null, pid: 123 }, generation: 2 }, events = [];
  const event = (sessionId, type, context) => JSON.stringify({ sessionId, event: type, context }) + '\n';
  try {
    writeFileSync(file, event('other', 'mcp.startup.completed', { serverCount: 1, statusCounts: { connected: 1 } }) + event('own', 'mcp.startup.scheduled', { serverCount: 1 }), 'utf8');
    let done = false; const pending = api.waitNativeMcpReady(root, child, 'own', e => events.push(e), 500).then(() => { done = true; });
    await delay(30); assert.equal(done, false);
    writeFileSync(file, event('own', 'mcp.startup.completed', { serverCount: 1, statusCounts: { connected: 1 }, toolCount: 1 }), 'utf8');
    await pending; assert.equal(events.length, 1); assert.equal(events[0].sessionId, 'own');
    // M462 installed observation: native serverCount includes our four disabled
    // overrides; statusCounts records disabled:4 and only official connected:1.
    writeFileSync(file, event('own', 'mcp.startup.completed', { serverCount: 5, statusCounts: { disabled: 4, connected: 1 }, toolCount: 1 }), 'utf8');
    await api.waitNativeMcpReady(root, child, 'own', e => events.push(e), 50, 4);
    assert.equal(events.at(-1).disabled, 4);
    await assert.rejects(api.waitNativeMcpReady(root, child, 'own', () => {}, 50, 3), /unconfirmed/);
    await assert.rejects(api.waitNativeMcpReady(root, child, 'own', () => {}, 50), /unconfirmed/);
    writeFileSync(file, event('own', 'mcp.startup.completed', { serverCount: 5, statusCounts: { disabled: 4, connected: 0 } }), 'utf8');
    await assert.rejects(api.waitNativeMcpReady(root, child, 'own', () => {}, 50, 4), /unconfirmed/);
    for (const context of [{}, { serverCount: 1, statusCounts: {} }, { serverCount: 1, statusCounts: { connected: 1, error: 1 } }]) {
      writeFileSync(file, event('own', 'mcp.startup.completed', context), 'utf8');
      await assert.rejects(api.waitNativeMcpReady(root, child, 'own', () => {}, 50));
    }
    writeFileSync(file, event('own', 'mcp.startup.failed', {}), 'utf8');
    await assert.rejects(api.waitNativeMcpReady(root, child, 'own', () => {}, 50), /failed/);
    writeFileSync(file, event('other', 'mcp.startup.completed', { serverCount: 1, statusCounts: { connected: 1 } }), 'utf8');
    await assert.rejects(api.waitNativeMcpReady(root, child, 'own', () => {}, 30), /timed out/);
    child.child.exitCode = 1;
    await assert.rejects(api.waitNativeMcpReady(root, child, 'own', () => {}, 30), /died/);
  } finally { rmSync(root, { recursive: true }); }
});
