import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { threadDeltaSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { experimental_assembleCapturedThreadEvents as assemble,
  experimental_assembleRecordedEvents as replay, experimental_createBridgeDeltaEventCollector as collector } from '@get-bb/plugin-sdk/provider-bridge/testing';
import { api, artifact, rows, snapshot, frame, delta, wires, complete, inputs } from './helpers.mjs';
import { assertHostNode as executableGuard } from '../../scripts/provider/guard.mjs';

function verified(ds) {
  for (const d of ds) {
    threadDeltaSchema.parse(d);
    assert.ok(d.providerTurnId);
  }
  const messages = [{ jsonrpc: '2.0', method: 'thread/delta', params: { threadId: 'thr_2222222222', deltas: ds } }];
  const r = replay({ dir: '.', manifest: null, entries: messages.map((m, i) => ({ ts: i, run: 1, seq: i, dir: 'bridge→runtime', line: JSON.stringify(m) })) }, collector, 'zcode');
  assert.deepEqual(r.invalidDeltas, []);
  assert.deepEqual(r.grammarViolations, []);
  return assemble(messages, 'zcode');
}
const translator = (warn = () => {}) => new api.EventTranslator('session1', 'epoch1', 1, warn);

test('R-01 leading orphan history skips once; known later turn remains faithful on SDK', () => {
  const warnings = [], t = translator(d => warnings.push(d.code));
  const s = snapshot([{ rowId: 6, kind: 'assistantText', turnId: 'old', state: 'complete', text: 'old' }, ...rows('later', 7)]);
  s.rows.totalCount = 100;
  const ds = t.project(s, 1, inputs(s.rows.window)), ev = verified(ds);
  assert.ok(JSON.stringify(ev).includes('text-later'));
  assert.ok(JSON.stringify(ev).includes('written'));
  assert.equal(ds.filter(d => d.kind === 'turn.boundary').length, 1);
  assert.deepEqual(t.project(s, 1), []);
  assert.deepEqual(warnings, ['execution-fields-unavailable', 'historical-row-skipped', 'generic-native-tool']);
});
test('R-01 known active orphan binds same-context checkpoint; unidentified active demands recovery', () => {
  const t = translator(), rs = rows();
  rs[0].state = 'running'; rs[1].state = 'streaming'; rs[2].status = 'running';
  const first = t.project(snapshot(rs), 1);
  const restored = new api.EventTranslator('session1', 'epoch1', 2, () => {});
  restored.restore(t.checkpoint());
  rs[1].text += ' suffix';
  const second = restored.project(snapshot([rs[1], ...rows('next', 4)]), 2);
  assert.deepEqual(second.filter(d => d.kind === 'item.textDelta' && d.providerTurnId === 'turn1').map(d => d.text), [' suffix']);
  verified([...first, ...second]);
  assert.throws(() => translator().project(snapshot([rs[1]]), 1), /missing-active-turn-header/);
  assert.throws(() => translator().project(snapshot([rows()[0], { ...rs[1], turnId: 'unknown' }]), 1), /missing-active-turn-header/);
});
test('R-02 interrupted/failed closes present and vanished tool/text/reasoning once before boundary', () => {
  for (const [state, expected] of [['completedInterrupted', 'interrupted'], ['failed', 'failed']]) {
    for (const vanished of [false, true]) {
      const t = translator(), rs = rows();
      rs[0].state = 'running'; rs[1].state = 'streaming'; rs[2].status = 'running';
      rs.push({ rowId: 4, kind: 'reasoning', turnId: 'turn1', state: 'streaming', text: 'reasoning-prefix' });
      const first = t.project(snapshot(rs), 1);
      rs[0].state = state;
      const end = snapshot([rs[0], ...(vanished ? [] : rs.slice(1)), ...rows('next', 5)]);
      const final = t.project(end, 1, inputs(rows('next', 5))), ev = verified([...first, ...final]);
      assert.equal(final.filter(d => d.kind === 'item.textClose').length, 3); // two interrupted + next text
      assert.equal(final.find(d => d.kind === 'item.close' && d.providerTurnId === 'turn1').status, expected);
      assert.equal(final.filter(d => d.kind === 'turn.boundary' && d.providerTurnId === 'turn1').length, 1);
      assert.equal(ev.filter(e => e.type === 'turn/completed')[0].status, expected);
      assert.ok(JSON.stringify(ev).includes('reasoning-prefix'));
      assert.ok(JSON.stringify(ev).includes('text-turn1'));
      assert.deepEqual(t.project(end, 1), []);
    }
  }
});
test('R-03 command acceptance survives until committed projection; 2200 commands and questions retire', () => {
  const c = new api.CommandCorrelation(), a = new api.InteractionArbiter(), t = translator();
  for (let i = 0; i < 2200; i++) {
    const id = 'command-t' + i, turn = 't' + i;
    c.begin(id, 'creq_2222222222', 1, 100);
    c.authoritative(id, 1, 'inputAccepted', turn);
    assert.ok(c.acceptance(id, 1));
    const ds = t.project(snapshot(rows(turn, i * 3 + 1)), 1, c);
    assert.equal(ds[0].kind, 'turn.open'); assert.equal(ds[1].kind, 'input.accepted');
    assert.equal(c.acceptance(id, 1), null);
    assert.equal(c.authoritative(id, 1, 'inputAccepted', turn), false);
    assert.throws(() => c.begin(id, 'r', 1, 100), /duplicate-command/);
    a.observe('q' + i, 1);
    a.resolve('q' + i, 1, {}, 'auto-resolution');
    a.observe('q' + i, 1);
    assert.equal(a.propose('q' + i, 1, 'v4', 'late'), false);
  }
  const cp = JSON.parse(t.checkpoint());
  assert.ok(cp.turns.length <= 256); assert.ok(cp.items.length <= 1024);
  const restored = translator(); restored.restore(t.checkpoint());
  assert.deepEqual(restored.project(snapshot(rows('t0', 1)), 1), []);
});
test('R-03 rejected commands retire; pending/unknown/unprojected acceptance still bound and stale callbacks do nothing', () => {
  const rejected = new api.CommandCorrelation();
  for (let i = 0; i < 2200; i++) { rejected.begin('c' + i, 'r', 1, 1); rejected.authoritative('c' + i, 1, 'rejected'); }
  const c = new api.CommandCorrelation();
  for (let i = 0; i < 1024; i++) c.begin('pending' + i, 'r', 1, 10);
  c.expire(10);
  assert.doesNotThrow(() => c.begin('overflow', 'r', 2, 20));
  assert.equal(c.status('pending0'), 'unknown');
  assert.equal(c.authoritative('pending0', 1, 'inputAccepted', 't'), false);
  assert.equal(c.consume('pending0', 1), false);
  const a = new api.InteractionArbiter();
  for (let i = 0; i < 1024; i++) a.observe('q' + i, 1);
  assert.doesNotThrow(() => a.observe('overflow', 1));
  a.observe('new-generation', 2);
  assert.equal(a.resolve('q0', 1, 'late', 'human'), false);
});
test('R-04 checkpoint excludes all payload markers/signatures; long stream bounded, restore suffix/dedup and prefix tamper fail', () => {
  const t = translator(), rs = rows();
  rs[0].state = 'running'; rs[1].state = 'streaming'; rs[2].status = 'running';
  rs[1].text = 'SYNTHETIC_PRIVATE_TEXT';
  rs[2].input = { value: 'SYNTHETIC_PRIVATE_ARGS' }; rs[2].output = { text: 'SYNTHETIC_PRIVATE_RESULT' };
  t.project(snapshot(rs), 1);
  const cp = t.checkpoint();
  for (const marker of ['SYNTHETIC_PRIVATE_TEXT', 'SYNTHETIC_PRIVATE_ARGS', 'SYNTHETIC_PRIVATE_RESULT', 'signature']) assert.ok(!cp.includes(marker));
  for (let i = 0; i < 20; i++) { rs[1].text += 'x'.repeat(32000); t.project(snapshot(rs), 1); }
  assert.ok(t.checkpoint().length < cp.length + 20);
  const restore = translator(); restore.restore(t.checkpoint());
  assert.deepEqual(restore.project(snapshot(rs), 1), []);
  rs[1].text += ' tail';
  assert.deepEqual(restore.project(snapshot(rs), 1).filter(d => d.kind === 'item.textDelta').map(d => d.text), [' tail']);
  rs[1].text = 'wrong-prefix';
  assert.throws(() => restore.project(snapshot(rs), 1), /rewrite/);
  const tampered = JSON.parse(cp); tampered.items.find(([, x]) => x.kind === 'assistantText')[1].prefix = '0'.repeat(64);
  const bad = translator(); bad.restore(JSON.stringify(tampered));
  assert.throws(() => bad.project(snapshot(rows()), 1), /rewrite/);
  assert.throws(() => bad.restore(JSON.stringify({ ...JSON.parse(cp), version: 1 })), /unsupported-checkpoint-version/);
  assert.throws(() => new api.EventTranslator('other', 'epoch1', 1, () => {}).restore(cp), /context/);
  assert.throws(() => bad.restore('x'.repeat(1024 * 1024 + 1)), /invalid-checkpoint/);
});
test('R-04 active payload above former 32 MiB cap retains unfinished items', () => {
  const t = translator(), rs = [rows()[0]]; rs[0].state = 'running';
  for (let i = 0; i < 33; i++) rs.push({ rowId: i + 2, kind: 'assistantText', turnId: 'turn1', state: 'streaming', text: 'x'.repeat(1024 * 1024) });
  const before = t.checkpoint();
  assert.equal(t.project(snapshot(rs), 1).filter(d => d.kind === 'item.open').length, 33);
  assert.equal(JSON.parse(t.checkpoint()).items.length, 33);
  assert.deepEqual(t.project(snapshot(rs), 1), []);
  assert.notEqual(t.checkpoint(), before);
});
test('R-03 projection failure preserves authoritative acceptance until successful retry', () => {
  const c = new api.CommandCorrelation(), t = translator(), rs = rows();
  c.begin('command-turn1', 'creq_2222222222', 1, 10);
  c.authoritative('command-turn1', 1, 'inputAccepted', 'turn1');
  rs[2].toolName = '';
  const before = t.checkpoint();
  assert.throws(() => t.project(snapshot(rs), 1, c));
  assert.ok(c.acceptance('command-turn1', 1)); assert.equal(t.checkpoint(), before);
  const ds = t.project(snapshot(rows()), 1, c);
  assert.equal(ds[0].kind, 'turn.open'); assert.equal(ds[1].kind, 'input.accepted'); assert.equal(c.acceptance('command-turn1', 1), null);
  verified(ds);
});
test('R-03 completed baseline stays silent until late authoritative input acceptance then settles once', () => {
  const c = new api.CommandCorrelation(), t = translator(), rs = rows();
  c.begin('command-turn1', 'creq_2222222222', 1, 10);
  const first = t.project(snapshot(rs), 1, c);
  assert.ok(!first.some(d => d.kind === 'input.accepted'));
  c.authoritative('command-turn1', 1, 'inputAccepted', 'turn1');
  const late = t.project(snapshot(rs), 1, c);
  assert.equal(first.length, 0); assert.equal(late[0].kind, 'turn.open'); assert.equal(late[1].kind, 'input.accepted');
  assert.equal(late.filter(d => d.kind === 'turn.boundary').length, 1);
  assert.equal(c.acceptance('command-turn1', 1), null);
  verified([...first, ...late]);
  assert.deepEqual(t.project(snapshot(rs), 1, c), []);
});
test('R-05 warning dedup is once per entity/value/generation with bounded history and visible new values', () => {
  const warnings = [], s = new api.ConversationState(d => warnings.push(d.code));
  s.attach(1, 'session1', 'subscription1');
  const rs = [...rows(), { rowId: 9, kind: 'future' }];
  s.ingest(frame(snapshot(rs)), 1);
  for (let i = 1; i < 6; i++) s.ingest(delta([{ op: 'state.updated', patch: { tick: i } }], i, i + 1), 1);
  assert.equal(warnings.filter(c => c === 'unknown-row-kind').length, 1);
  s.ingest(delta([{ op: 'row.upserted', row: { rowId: 9, kind: 'new-value' } }], 6, 7), 1);
  assert.equal(warnings.filter(c => c === 'unknown-row-kind').length, 2);
  s.attach(2, 'session1', 'subscription1'); s.ingest(frame(snapshot(rs)), 2);
  assert.equal(warnings.filter(c => c === 'unknown-row-kind').length, 3);
  let n = 0; const bounded = api.boundedWarnings(() => n++, 2);
  for (const id of [1, 1, 2, 3, 1]) bounded({ code: 'fixed' }, id);
  assert.equal(n, 4);
});
test('R-05 unknown terminal warning once/value; confirmed terminal closes unknown tool without inventing tool success', () => {
  const warnings = [], rs = rows(), t = translator(d => warnings.push(d.code));
  rs[2].status = 'unknown-outcome';
  rs[0].state = 'unknown-terminal';
  const ds = t.project(snapshot(rs), 1, inputs(rs));
  assert.equal(ds.some(d => d.kind === 'turn.boundary'), false);
  t.project(snapshot(rs), 1); t.project(snapshot(rs), 1);
  rs[0].state = 'another-terminal'; t.project(snapshot(rs), 1);
  assert.equal(warnings.filter(c => c === 'unknown-terminal-state').length, 2);
  rs[0].state = 'completedSuccess';
  const end = t.project(snapshot(rs), 1);
  assert.equal(end.filter(d => d.kind === 'turn.boundary').length, 1);
  assert.equal(end.find(d => d.kind === 'item.close').status, 'failed');
});
test('R-06 workflow degraded update/remove keeps known frame data and background explicitly unknown', () => {
  const warnings = [], s = new api.ConversationState(d => warnings.push(d.code)); s.attach(1, 'session1', 'subscription1');
  s.ingest(frame(snapshot(rows())), 1);
  s.ingest(delta([{ op: 'workflowRun.updated', runId: 'r', revision: 1 }, { op: 'row.delta', rowId: 2, path: 'text', append: '!' }]), 1);
  s.ingest(delta([{ op: 'workflowRun.updated', runId: 'r', revision: 2 }, { op: 'workflowRun.removed', runId: 'r' }], 2, 3), 1);
  assert.equal(s.requiresSnapshot, false); assert.equal(s.workflowProjection, 'unknown');
  assert.equal(s.snapshot.rows.window[1].text, 'text-turn1!');
  assert.equal(warnings.filter(c => c === 'workflow-projection-degraded').length, 2);
  const before = s.snapshot;
  assert.throws(() => s.ingest(delta([{ op: 'row.delta', rowId: 2, path: 'text', append: 'no-commit' }, { op: 'workflowRun.updated', runId: 'r' }], 3, 4), 1));
  assert.deepEqual(s.snapshot, before);
});
test('R-08 expired unrelated assembly warns and ingests current correct frame in same call', () => {
  const warnings = [], d = new api.FrameDecoder(x => warnings.push(x.code), { timeoutMs: 10 });
  d.ingest(wires(frame())[0], 0);
  assert.deepEqual(d.ingest(complete(frame()), 10), frame());
  assert.equal(d.pending, 0); assert.deepEqual(warnings, ['assembly-timeout']);
});
test('R-09 no partial-input open; complete-input open and final full args/result survive actual assembler', () => {
  const t = translator(), rs = rows(); rs[0].state = 'running'; rs[2].status = 'inputStreaming';
  rs[2].input = { partial: 'x' };
  const first = t.project(snapshot(rs), 1);
  assert.equal(first.filter(d => d.kind === 'item.open' && d.item.type === 'tool').length, 0);
  rs[2].input = { complete: 'value' }; rs[2].status = 'running';
  const opened = t.project(snapshot(rs), 1);
  assert.deepEqual(opened.find(d => d.kind === 'item.open').item.args, { complete: 'value' });
  rs[2].input = { complete: 'final' }; rs[2].status = 'success'; rs[0].state = 'completedSuccess';
  const closed = t.project(snapshot(rs), 1);
  const ev = verified([...first, ...opened, ...closed]);
  assert.ok(JSON.stringify(ev).includes('value')); assert.ok(JSON.stringify(ev).includes('final')); assert.ok(JSON.stringify(ev).includes('written'));
});
test('R-10 explicit authoritative outcomes; empty answer/ACK never infer origin', () => {
  for (const outcome of ['human', 'auto-resolution', 'cancelled', 'unknown']) {
    const a = new api.InteractionArbiter(); a.observe('q', 1, { visibleAt: 10, deadlineAt: 20 });
    a.propose('q', 1, 'v4', {}); a.ack('q', 1, true);
    assert.equal(a.inspect('q', 1).outcome, 'unknown');
    a.resolve('q', 1, {}, outcome);
    const before = a.inspect('q', 1);
    assert.equal(before.outcome, outcome);
    assert.equal(before.state, outcome === 'cancelled' ? 'cancelled' : 'resolved');
    a.ack('q', 1, true); assert.deepEqual(a.inspect('q', 1), before);
  }
  const a = new api.InteractionArbiter(); a.observe('q', 1); a.resolve('q', 1, {});
  assert.equal(a.inspect('q', 1).outcome, 'unknown');
});
test('M-02 host and executable guards agree at boundaries, fail before build/test/host work, actual host supported', () => {
  for (const v of ['24.22.0', '24.99.1', '26.0.0']) {
    assert.doesNotThrow(() => api.assertHostNode(v)); assert.doesNotThrow(() => executableGuard(v));
  }
  for (const v of ['22.19.0', '22.99.1', '24.0.0', '24.21.99', '20.19.0', '23.0.0', '25.4.0', '27.0.0', 'v24.0.0', 'invalid', '24.0', '024.0.0', '24.00.0']) {
    assert.throws(() => api.assertHostNode(v), /Unsupported host Node/); assert.throws(() => executableGuard(v), /Unsupported host Node/);
  }
  api.assertHostNode(process.versions.node);
  for (const file of ['scripts/provider/build.mjs', 'scripts/provider/test.mjs', artifact ? 'dist/host.js' : 'src/host.ts']) {
    const url = new URL('file://' + resolve(file)).href;
    const p = spawnSync(process.execPath, ['--input-type=module', '-e', `Object.defineProperty(process.versions,'node',{value:'25.4.0'}); await import(${JSON.stringify(url)})`], { encoding: 'utf8' });
    assert.equal(p.status, 1); assert.match(p.stderr, /Unsupported host Node 25.4.0/);
    assert.ok(!p.stdout.includes('TAP')); assert.ok(!p.stderr.includes('Cannot find module'));
  }
});
