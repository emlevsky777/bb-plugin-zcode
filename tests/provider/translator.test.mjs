import test from 'node:test';
import assert from 'node:assert/strict';
import { threadDeltaSchema, threadDeltaNotificationParamsSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { experimental_assembleCapturedThreadEvents as assemble,
  experimental_assembleRecordedEvents as replay, experimental_createBridgeDeltaEventCollector as collector,
  experimental_normalizeCalibrationEvents as normalize } from '@get-bb/plugin-sdk/provider-bridge/testing';
import { api, accepted, rows, snapshot, inputs } from './helpers.mjs';
const events = ds => assemble([{ jsonrpc: '2.0', method: 'thread/delta', params: { threadId: 'thr_2222222222', deltas: ds } }], 'zcode');
test('K-110 real SDK mixed explicit/implicit identity loses items, translator preserves accepted text/tool/terminal', () => {
  const s = accepted.payload.snapshot, turn = s.rows.window.find(r => r.kind === 'turnHeader');
  const tool = s.rows.window.find(r => r.kind === 'toolCall'), text = s.rows.window.find(r => r.kind === 'assistantText');
  assert.equal(tool.input.content, 'NATIVE_OK'); assert.equal(tool.status, 'success'); assert.equal(turn.state, 'completedSuccess');
  const c = new api.CommandCorrelation(); c.begin(turn.sourceCommandId, 'creq_2222222222', 1, 100);
  c.ack(turn.sourceCommandId, 1); assert.equal(c.acceptance(turn.sourceCommandId, 1), null);
  c.authoritative(turn.sourceCommandId, 1, 'inputAccepted', turn.turnId);
  const t = new api.EventTranslator('accepted-session', s.logEpoch, 1, () => {}), ds = t.project(s, 1, c);
  const params = { threadId: 'thr_2222222222', deltas: ds };
  threadDeltaNotificationParamsSchema.parse(params);
  for (const d of ds) { threadDeltaSchema.parse(d); assert.equal(d.providerTurnId, turn.turnId); }
  const mixed = ds.map(d => {
    if (!d.kind.startsWith('item.')) return d;
    const { providerTurnId, ...withoutId } = d; return withoutId;
  });
  for (const d of mixed) threadDeltaSchema.parse(d); // schema-valid loss is the regression
  const lost = events(mixed), kept = events(ds);
  assert.equal(lost.length, 3); assert.equal(kept.length, 8);
  assert.ok(!JSON.stringify(lost).includes(tool.toolName));
  assert.ok(!JSON.stringify(lost).includes(text.text));
  assert.ok(kept.length > lost.length);
  assert.ok(kept.some(e => e.type === 'item/completed' && e.item.type === 'fileChange' && e.item.changes[0].path === tool.input.file_path));
  assert.ok(JSON.stringify(kept).includes(tool.output.text));
  assert.ok(JSON.stringify(kept).includes(text.text));
  assert.equal(ds.filter(d => d.kind === 'turn.boundary').length, 1);
  assert.equal(ds[0].kind, 'turn.open'); assert.equal(ds[1].kind, 'input.accepted');
  const messages = [{ jsonrpc: '2.0', method: 'thread/delta', params }];
  const result = replay({ dir: '.', manifest: null, entries: messages.map((m, i) => ({ ts: i, run: 1, seq: i, dir: 'bridge→runtime', line: JSON.stringify(m) })) }, collector, 'zcode');
  assert.equal(result.invalidDeltas.length, 0); assert.equal(result.grammarViolations.length, 0);
  assert.deepEqual(normalize(result.events), normalize(kept));
  const canonicalTurn = kept.find(e => e.type === 'turn/started').scope.turnId;
  assert.ok(kept.every(e => e.scope.turnId === canonicalTurn));
  const toolStart = kept.find(e => e.type === 'item/started' && e.item.type === 'fileChange');
  assert.equal(kept.find(e => e.type === 'item/completed' && e.item.type === 'fileChange').item.id, toolStart.item.id);
  assert.deepEqual(t.project(s, 1, c), []);
});
test('several turns have explicit identities and terminal once; stale callbacks have no effect', () => {
  const s = snapshot([...rows('turn1'), ...rows('turn2', 4)]);
  const t = new api.EventTranslator('session1', 'epoch1', 1, () => {});
  assert.deepEqual(t.project(s, 0), []);
  const ds = t.project(s, 1, inputs(s.rows.window)), ev = events(ds);
  assert.equal(ds.filter(d => d.kind === 'turn.open').length, 2);
  assert.equal(ds.filter(d => d.kind === 'turn.boundary').length, 2);
  assert.ok(JSON.stringify(ev).includes('text-turn1')); assert.ok(JSON.stringify(ev).includes('text-turn2'));
  assert.deepEqual(t.project(s, 1), []);
  assert.throws(() => t.project(snapshot(rows(), 'other'), 1), /epoch/);
});
test('streaming text appends only new suffix, full tool close carries result, rewrites fail atomically', () => {
  const rs = rows(); rs[0].state = 'running'; rs[1].state = 'streaming'; rs[1].text = 'first'; rs[2].status = 'running';
  const t = new api.EventTranslator('session1', 'epoch1', 1, () => {});
  const first = t.project(snapshot(rs), 1); assert.equal(first.filter(d => d.kind === 'item.open').length, 2);
  const checkpoint = t.checkpoint(); rs[1].text = 'rewrite';
  assert.throws(() => t.project(snapshot(rs), 1), /rewrite/); assert.equal(t.checkpoint(), checkpoint);
  rs[1].text = 'first second'; rs[1].state = 'complete'; rs[2].status = 'success'; rs[0].state = 'completedSuccess';
  const final = t.project(snapshot(rs), 1);
  assert.deepEqual(final.filter(d => d.kind === 'item.textDelta').map(d => d.text), [' second']);
  const close = final.find(d => d.kind === 'item.close'); assert.equal(close.item.tool, 'Write'); assert.equal(close.resultText, 'written');
  const ev = events([...first, ...final]); assert.ok(JSON.stringify(ev).includes('first second'));
  assert.equal(final.filter(d => d.kind === 'turn.boundary').length, 1);
});
test('checkpoint recovery is explicit same-context and prevents historical re-emission', () => {
  const t = new api.EventTranslator('session1', 'epoch1', 1, () => {}); t.project(snapshot(rows()), 1, inputs(rows()));
  const restored = new api.EventTranslator('session1', 'epoch1', 2, () => {}); restored.restore(t.checkpoint());
  assert.deepEqual(restored.project(snapshot(rows()), 2), []);
  assert.throws(() => new api.EventTranslator('other', 'epoch1', 2, () => {}).restore(t.checkpoint()), /context/);
  assert.throws(() => restored.restore('{}'), /context/);
  assert.deepEqual(restored.project(snapshot([rows()[1]]), 2), []);
});
test('unknown terminal enum preserves known text without synthetic success', () => {
  const warnings = [], rs = rows(); rs[0].state = 'future-terminal';
  const s = api.parseSnapshot(snapshot(rs), d => warnings.push(d.code));
  const ds = new api.EventTranslator('session1', 'epoch1', 1, d => warnings.push(d.code)).project(s, 1);
  assert.ok(JSON.stringify(events(ds)).includes('text-turn1'));
  assert.ok(warnings.includes('unknown-row-enum')); assert.ok(warnings.includes('unknown-terminal-state'));
  assert.equal(ds.filter(d => d.kind === 'turn.boundary').length, 0);
});
test('native failed/interrupted turn status and tool cancellation never become completed success', () => {
  for (const [state, expected] of [['failed', 'failed'], ['completedInterrupted', 'interrupted']]) {
    const rs = rows(); rs[0].state = state; rs[2].status = 'cancelled';
    const ds = new api.EventTranslator('session1', 'epoch1', 1, () => {}).project(api.parseSnapshot(snapshot(rs), () => {}), 1, inputs(rs));
    assert.equal(ds.find(d => d.kind === 'item.close').status, 'interrupted');
    assert.equal(ds.find(d => d.kind === 'turn.boundary').status, expected);
    assert.equal(events(ds).find(e => e.type === 'turn/completed').status, expected);
  }
});
