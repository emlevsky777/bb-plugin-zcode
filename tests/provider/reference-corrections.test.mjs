import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { threadDeltaSchema, threadDeltaNotificationParamsSchema, jsonRpcEnvelopeSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { experimental_assembleCapturedThreadEvents as assemble,
  experimental_assembleRecordedEvents as replay, experimental_createBridgeDeltaEventCollector as collector,
  experimental_normalizeCalibrationEvents as normalize } from '@get-bb/plugin-sdk/provider-bridge/testing';
import { api, rows, snapshot, inputs } from './helpers.mjs';

const controls = JSON.parse(readFileSync(new URL('./fixtures/control-states.json', import.meta.url), 'utf8'));
const control = phase => structuredClone(controls.find(s => s.scenario === phase).fields.control);
const state = (rs, phase = 'running') => ({ ...snapshot(rs), control: control(phase), backgroundWorks: [], pendingInteractions: [] });
const make = (warn = () => {}) => new api.EventTranslator('session1', 'epoch1', 1, warn);
function running(turn = 'turn1', base = 1) {
  const rs = rows(turn, base); rs[0].state = 'running'; rs[1].state = 'streaming'; rs[2].status = 'running';
  rs.push({ rowId: base + 3, kind: 'reasoning', turnId: turn, state: 'streaming', text: 'reasoning' }); return rs;
}
function verifiedMessages(messages) {
  for (const m of messages) {
    jsonRpcEnvelopeSchema.parse(m);
    if (m.method === 'thread/delta') {
      threadDeltaNotificationParamsSchema.parse(m.params);
      for (const d of m.params.deltas) threadDeltaSchema.parse(d);
    }
  }
  const r = replay({ dir: '.', manifest: null, entries: messages.map((m, i) => ({ ts: i, run: 1, seq: i, dir: 'bridge→runtime', line: JSON.stringify(m) })) }, collector, 'zcode');
  assert.deepEqual(r.invalidDeltas, []); assert.deepEqual(r.grammarViolations, []);
  const events = assemble(messages, 'zcode'); assert.deepEqual(normalize(r.events), normalize(events));
  return events;
}
function verified(ds) {
  return verifiedMessages([{ jsonrpc: '2.0', method: 'thread/delta', params: { threadId: 'thr_2222222222', deltas: ds } }]);
}

test('R-11 all confirmed terminal outcomes close present/vanished full payloads before one boundary', () => {
  for (const [native, status] of [['completedSuccess', 'completed'], ['failed', 'failed'], ['completedInterrupted', 'interrupted']]) {
    for (const vanished of [false, true]) {
      const t = make(), rs = running(), c = inputs(rs);
      const first = t.project(snapshot(rs), 1, c); rs[0].state = native;
      const end = snapshot(vanished ? [rs[0]] : rs);
      const final = t.project(end, 1);
      assert.equal(final.filter(d => d.kind === 'item.textClose').length, 2);
      assert.equal(final.filter(d => d.kind === 'item.close').length, 1);
      assert.deepEqual(final.find(d => d.kind === 'item.close').item.args, rs[2].input);
      assert.equal(final.find(d => d.kind === 'item.close').resultText, 'written');
      for (const d of [...first, ...final]) assert.equal(d.providerTurnId, 'turn1');
      assert.equal(final.at(-1).kind, 'turn.boundary'); assert.equal(final.at(-1).status, status);
      const events = verified([...first, ...final]);
      assert.ok(JSON.stringify(events).includes('text-turn1')); assert.ok(JSON.stringify(events).includes('reasoning'));
      assert.equal(events.filter(e => e.type === 'turn/completed').length, 1);
      assert.deepEqual(t.project(end, 1), []);
    }
  }
});
test('R-12 control terminal closes known turn when header or entire window is gone, never synthetic running', () => {
  for (const phase of ['completedSuccess', 'completedInterrupted']) {
    for (const window of ['items', 'empty']) {
      const t = make(), rs = running(), first = t.project(state(rs), 1, inputs(rs));
      const end = state(window === 'empty' ? [] : rs.slice(1), phase);
      const final = t.project(end, 1), events = verified([...first, ...final]);
      assert.equal(final.filter(d => d.kind === 'turn.boundary').length, 1);
      assert.equal(events.filter(e => e.type === 'turn/completed').length, 1);
      assert.deepEqual(t.project(end, 1), []);
    }
  }
});
test('R-12 headerless active window can bind one native turn with exact control evidence', () => {
  const rs = running(), t = make();
  const first = t.project(state(rs.slice(1)), 1);
  rs[1].text += ' suffix';
  const second = t.project(state(rs.slice(1)), 1);
  assert.deepEqual(second.filter(d => d.kind === 'item.textDelta').map(d => d.text), [' suffix']);
  const final = t.project(state([], 'completedSuccess'), 1);
  assert.equal(verified([...first, ...second, ...final]).filter(e => e.type === 'turn/completed').length, 1);
});
test('R-12 unknown/idle/missing/conflicting work and pending interactions stay visibly unresolved', () => {
  for (const variant of ['unknownPhase', 'idle', 'missingWorks', 'missingBackground', 'unknownWork', 'unknownBackground', 'waiting', 'background', 'resultPending', 'conflict', 'emptyRunning']) {
    const warnings = [], t = make(d => warnings.push(d.code)), rs = running();
    const first = t.project(state(rs), 1, inputs(rs));
    const end = state([], 'completedSuccess');
    if (variant === 'unknownPhase') end.control.phase = 'future-state';
    if (variant === 'idle') end.control.phase = 'idle';
    if (variant === 'missingWorks') delete end.control.activeWorks;
    if (variant === 'missingBackground') delete end.backgroundWorks;
    if (variant === 'unknownWork') end.control.activeWorks = [{ kind: 'future-work' }];
    if (variant === 'unknownBackground') end.backgroundWorks = [{ status: 'future-status' }];
    if (variant === 'waiting') end.pendingInteractions = [{ kind: 'userInput', requestId: 'q' }];
    // M48 detaches native subagents like Bash; unsupported workflows still block.
    if (variant === 'background' || variant === 'resultPending') end.backgroundWorks = [{ workId: 'bg', kind: 'workflow', status: variant === 'background' ? 'running' : 'resultPending' }];
    if (variant === 'conflict') end.rows = snapshot(rs).rows;
    if (variant === 'emptyRunning') { end.control = control('running'); end.control.activeWorks = []; }
    const ds = t.project(end, 1);
    assert.equal(ds.some(d => d.kind === 'turn.boundary'), false, variant);
    verified([...first, ...ds]);
    if (variant !== 'emptyRunning') assert.ok(warnings.length, variant);
    const final = t.project(state([], 'completedSuccess'), 1);
    assert.equal(final.filter(d => d.kind === 'turn.boundary').length, 1, variant);
    verified([...first, ...ds, ...final]);
  }
});
test('R-12 terminal header conflicts with active control and opposite confirmed outcome', () => {
  for (const phase of ['running', 'completedInterrupted']) {
    const warnings = [], t = make(d => warnings.push(d.code)), rs = running();
    const first = t.project(state(rs), 1, inputs(rs)); rs[0].state = 'completedSuccess';
    const ds = t.project(state(rs, phase), 1);
    assert.equal(ds.some(d => d.kind === 'turn.boundary'), false);
    assert.ok(warnings.includes('conflicting-terminal-sources'));
    verified([...first, ...ds]);
  }
});
test('B-03 cold attach/resume suppresses every completed turn including new IDs and shifted windows', () => {
  for (const generation of [1, 2]) {
    const t = new api.EventTranslator('session1', 'epoch1', generation, () => {});
    assert.deepEqual(t.project(snapshot([...rows('history'), ...rows('history2', 4)]), generation), []);
    assert.deepEqual(t.project(snapshot(rows('new-history-id', 9000)), generation), []);
    assert.deepEqual(t.project(snapshot([rows('orphan-history', 9999)[1]]), generation), []);
    assert.deepEqual(JSON.parse(t.checkpoint()).turns, []);
  }
});
test('B-03 first baseline keeps active continuation and no completed history, duplicate terminal once', () => {
  const t = make(), rs = running('active', 100);
  const first = t.project(state([...rows('history'), ...rs]), 1);
  assert.ok(first.every(d => d.providerTurnId === 'active'));
  rs[1].text += ' tail';
  const second = t.project(state([...rows('shifted-history', 9000), ...rs]), 1);
  assert.deepEqual(second.filter(d => d.kind === 'item.textDelta').map(d => d.text), [' tail']);
  const end = t.project(state([], 'completedSuccess'), 1);
  assert.equal(verified([...first, ...second, ...end]).filter(e => e.type === 'turn/completed').length, 1);
  assert.deepEqual(t.project(state([], 'completedSuccess'), 1), []);
});
test('B-03 checkpoint metadata only; vanished payload after restore diagnoses loss and never invents args', () => {
  const warnings = [], t = make(), rs = running(); t.project(snapshot(rs), 1);
  const checkpoint = t.checkpoint();
  for (const marker of ['text-turn1', 'NATIVE_OK', 'written']) assert.ok(!checkpoint.includes(marker));
  const restored = new api.EventTranslator('session1', 'epoch1', 2, d => warnings.push(d.code));
  restored.restore(checkpoint); rs[0].state = 'completedSuccess';
  const final = restored.project(snapshot([rs[0]]), 2);
  const tool = final.find(d => d.kind === 'item.close');
  assert.ok(!('args' in tool.item)); assert.equal(tool.status, 'failed');
  assert.ok(warnings.includes('terminal-tool-payload-unavailable')); assert.ok(warnings.includes('terminal-text-payload-unavailable'));
  assert.equal(final.at(-1).kind, 'turn.boundary');
});
test('B-03 active ledger exceeds former 1024 cap without evicting active identities', () => {
  const t = make(), rs = [running()[0]];
  for (let i = 0; i < 1500; i++) rs.push({ rowId: i + 2, kind: 'assistantText', turnId: 'turn1', state: 'streaming', text: 'x' });
  const first = t.project(snapshot(rs), 1), cp = JSON.parse(t.checkpoint());
  assert.equal(cp.items.length, 1500);
  rs[0].state = 'completedSuccess';
  const final = t.project(snapshot([rs[0]]), 1);
  assert.equal(final.filter(d => d.kind === 'item.textClose').length, 1500);
  verified([...first, ...final]);
});
test('B-11/B-12 zero-work authoritative acceptance opens before accepted in same batch and has one terminal', () => {
  const t = make(), c = inputs([rows()[0]]);
  const first = t.project(state([], 'completedSuccess'), 1, c);
  assert.deepEqual(first.map(d => d.kind), ['turn.open', 'input.accepted', 'turn.boundary']);
  assert.equal(first[1].clientRequestId, 'creq_2222222222'); assert.equal(first[1].providerTurnId, 'turn1');
  assert.equal(c.acceptance('command-turn1', 1), null);
  assert.equal(c.ack('command-turn1', 1), false); assert.equal(c.authoritative('command-turn1', 1, 'inputAccepted', 'turn1'), false);
  assert.deepEqual(t.project(state([], 'completedSuccess'), 1, c), []); verified(first);
});
test('B-12 failed turn suppresses ghost until next explicit accepted input; unknown ACK never opens', () => {
  const t = make(), rs = running(), c = inputs(rs), first = t.project(snapshot(rs), 1, c);
  rs[0].state = 'failed'; const end = t.project(snapshot(rs), 1);
  assert.deepEqual(t.project(snapshot(running('ghost', 20)), 1), []);
  assert.deepEqual(t.project(snapshot(running('ghost', 20)), 0, c), []);
  const pending = new api.CommandCorrelation(); pending.begin('command-next', 'creq_2222222222', 1, 100); pending.ack('command-next', 1);
  assert.deepEqual(t.project(snapshot(running('next', 30)), 1, pending), []);
  pending.authoritative('command-next', 1, 'inputAccepted', 'next');
  const next = t.project(snapshot(rows('next', 30)), 1, pending);
  assert.deepEqual(next.slice(0, 2).map(d => d.kind), ['turn.open', 'input.accepted']);
  verified([...first, ...end, ...next]);
  const restored = make(); restored.restore(t.checkpoint());
  assert.throws(() => restored.project({ ...snapshot([]), sessionId: 'other' }, 1), /session-mismatch/);
});
function lifecycle() {
  const messages = [], order = []; let frees = 0;
  const l = new api.SessionLifecycle('thr_2222222222', 'session1', 'epoch1', 1, () => {},
    m => { messages.push(m); order.push(m.method); }, async () => { frees++; order.push('free'); return 0; });
  return { l, messages, order, frees: () => frees };
}
function backgrounds(l) {
  for (const [id, item] of [['bg', { type: 'backgroundTask', familyId: 'family', taskType: 'bash', description: 'synthetic work', status: 'pending', taskStatus: 'running', skipTranscript: false }],
    ['agent', { type: 'delegation', childRef: 'child', label: 'synthetic agent', background: true }]]) {
    l.openWork({ kind: 'item.open', providerTurnId: 'turn1', key: { providerItemId: id }, item }, 1, 'session1');
  }
}
test('B-13 death closes every turn/item/background/delegation as failed; stale callbacks cannot open', async () => {
  const { l, messages, frees } = lifecycle(), rs = [...running(), ...running('t2', 10)];
  l.project(snapshot(rs), 1, 'session1', inputs(rs)); backgrounds(l);
  await l.processDied(0, 'session1'); await l.processDied(1, 'other'); assert.equal(frees(), 0);
  await l.processDied(1, 'session1');
  const count = messages.length;
  await l.processDied(1, 'session1'); l.project(snapshot(running('late', 30)), 1, 'session1');
  assert.equal(messages.length, count); assert.equal(frees(), 1);
  const events = verifiedMessages(messages), ds = messages.filter(m => m.method === 'thread/delta').flatMap(m => m.params.deltas);
  assert.equal(ds.filter(d => d.kind === 'turn.boundary').length, 2);
  assert.ok(ds.filter(d => d.kind === 'turn.boundary').every(d => d.status === 'failed'));
  assert.equal(ds.filter(d => d.kind === 'item.close' && ['backgroundTask', 'delegation'].includes(d.item.type)).length, 2);
  assert.equal(events.filter(e => e.type === 'turn/completed').length, 2);
  assert.equal(messages.at(-1).method, 'error');
});
test('B-13 death of accepted zero-work before projection still gives open/accepted/failed exactly once', async () => {
  const { l, messages } = lifecycle(), c = inputs([rows()[0]]);
  await l.processDied(1, 'session1', c);
  assert.deepEqual(messages[0].params.deltas.map(d => d.kind), ['turn.open', 'input.accepted', 'turn.boundary']);
  assert.equal(messages[0].params.deltas.at(-1).status, 'failed'); verifiedMessages(messages);
});
test('B-13 replacement settles before reset/replaced, proven same context only, next resume baseline', async () => {
  for (const preserved of [true, undefined, false]) {
    const { l, messages, order } = lifecycle(), rs = running();
    l.project(snapshot(rs), 1, 'session1', inputs(rs)); backgrounds(l);
    await l.replaced('session1', 'epoch1', 2, preserved);
    const resetIndex = messages.findIndex(m => m.method === 'thread/delta' && m.params.deltas.some(d => d.kind === 'session.reset'));
    const boundaryIndex = messages.findIndex(m => m.method === 'thread/delta' && m.params.deltas.some(d => d.kind === 'turn.boundary'));
    assert.ok(boundaryIndex < resetIndex);
    assert.ok(order.indexOf('free') < order.indexOf('session/replaced'));
    assert.equal(messages.at(-1).params.contextLost, preserved !== true);
    const count = messages.length;
    l.project(snapshot(rows('old-history', 100)), 2, 'session1'); l.project(snapshot(running('late', 200)), 1, 'session1');
    assert.equal(messages.length, count); verifiedMessages(messages);
  }
  const { l, messages } = lifecycle();
  await assert.rejects(l.replaced('other', 'epoch1', 2, true), /context-conflict/); assert.equal(messages.length, 0);
});
test('historical decision component deltas before stop response; idle stop frees process, release never fabricates interrupted', async () => {
  for (const intent of ['interrupt', 'release']) {
    for (const active of [true, false]) {
      const { l, messages, order, frees } = lifecycle();
      if (active) { const rs = running(); l.project(snapshot(rs), 1, 'session1', inputs(rs)); backgrounds(l); }
      await l.stop(intent, 1, 'session1'); order.push('stop-response');
      assert.equal(frees(), 1); assert.ok(order.indexOf('free') < order.indexOf('stop-response'));
      const events = verifiedMessages(messages);
      assert.equal(events.filter(e => e.type === 'turn/completed').length, active ? 1 : 0);
      if (intent === 'release') assert.ok(!events.some(e => e.type === 'turn/completed' && e.status === 'interrupted'));
      const count = messages.length; await l.stop(intent, 1, 'session1'); assert.equal(messages.length, count); assert.equal(frees(), 1);
    }
  }
});
test('historical decision idle background cleanup and failed ownership remain visible instead of fake successful stop', async () => {
  const { l, messages, frees } = lifecycle(), rs = running();
  l.project(snapshot(rs), 1, 'session1', inputs(rs)); backgrounds(l);
  rs[0].state = 'completedSuccess'; l.project(snapshot(rs), 1, 'session1');
  await l.stop('release', 1, 'session1'); assert.equal(frees(), 1);
  const ds = messages.filter(m => m.method === 'thread/delta').flatMap(m => m.params.deltas);
  assert.equal(ds.filter(d => d.kind === 'turn.boundary').length, 1);
  assert.equal(ds.filter(d => d.kind === 'item.close' && ['backgroundTask', 'delegation'].includes(d.item.type) && d.status === 'failed').length, 2);
  verifiedMessages(messages);
  const failedMessages = [], failed = new api.SessionLifecycle('thr_2222222222', 'session1', 'epoch1', 1, () => {}, m => failedMessages.push(m), async () => 1);
  failed.project(snapshot(running()), 1, 'session1', inputs(running()));
  await assert.rejects(failed.stop('interrupt', 1, 'session1'), /owned-resources-remain/);
  assert.equal(failedMessages.at(-1).params.deltas.at(-1).kind, 'turn.boundary'); verifiedMessages(failedMessages);
});
test('B-15 stdout strict batch recovery is bounded/redacted; JSON errors and wrong RPC correlation surface', () => {
  const decoder = new api.JsonLineDecoder(128), marker = 'SYNTHETIC_SECRET_STDOUT';
  assert.deepEqual(decoder.feed(Buffer.from('log ' + marker + '\n')), []);
  assert.throws(() => decoder.feed(Buffer.from('{bad ' + marker + '\n')), e => e.code === 'malformed-protocol-line' && !e.message.includes(marker));
  assert.equal(decoder.feed(Buffer.from('{"jsonrpc":"2.0","id":"rpc","error":{"code":-1,"message":"' + marker + '"}}\n'))[0].error.code, -1);
  const replies = new api.RpcReplies(1); replies.begin('rpc');
  assert.throws(() => replies.response({ jsonrpc: '2.0', id: 'other', result: {} }, 1), /correlation-mismatch/);
  assert.deepEqual(replies.response({ jsonrpc: '2.0', id: 'rpc', result: {} }, 0), { kind: 'stale' });
  assert.throws(() => replies.response({ jsonrpc: '2.0', id: 'rpc', error: { code: -1, message: marker } }, 1), e => e.code === 'native-rpc-error' && !e.message.includes(marker));
  replies.begin('rpc2');
  assert.throws(() => replies.response({ jsonrpc: '2.0', id: 'rpc2', result: 1, error: {} }, 1), /invalid-native-rpc-response/);
  assert.deepEqual(replies.response({ jsonrpc: '2.0', id: 'rpc2', result: { accepted: true } }, 1), { kind: 'result', value: { accepted: true } });
  const c = new api.CommandCorrelation(); c.begin('cmd', 'creq_2222222222', 1, 100); c.ack('cmd', 1); assert.equal(c.acceptance('cmd', 1), null);
  assert.throws(() => decoder.feed(Buffer.alloc(129, 120)), /line-too-large/);
  assert.deepEqual(decoder.feed(Buffer.from('{}\n')), [{}]);
});
test('B-11 unknown admission waits; late confirmed acceptance and terminal commit together, conflict atomic', () => {
  const warnings = [], t = make(d => warnings.push(d.code)), rs = running(), c = new api.CommandCorrelation();
  c.begin('command-turn1', 'creq_2222222222', 1, 10); c.ack('command-turn1', 1);
  assert.deepEqual(t.project(snapshot(rs), 1, c), []);
  c.expire(10); rs[0].state = 'completedSuccess';
  assert.deepEqual(t.project(snapshot(rs), 1, c), []);
  assert.ok(warnings.includes('input-acceptance-unconfirmed'));
  c.authoritative('command-turn1', 1, 'inputAccepted', 'turn1');
  const ds = t.project(snapshot(rs), 1, c);
  assert.deepEqual(ds.slice(0, 2).map(d => d.kind), ['turn.open', 'input.accepted']);
  assert.equal(ds.filter(d => d.kind === 'turn.boundary').length, 1); verified(ds);
  const bad = make(), wrong = new api.CommandCorrelation(); wrong.begin('command-turn1', 'creq_2222222222', 1, 10);
  wrong.authoritative('command-turn1', 1, 'inputAccepted', 'different'); const before = bad.checkpoint();
  assert.throws(() => bad.project(snapshot(rs), 1, wrong), /command-turn-conflict/);
  assert.equal(bad.checkpoint(), before); assert.ok(wrong.acceptance('command-turn1', 1));
});
test('R-12 unknown header does not become success via control; error phase closes as failed', () => {
  const t = make(), rs = running(); const first = t.project(state(rs), 1, inputs(rs));
  rs[0].state = 'future-terminal';
  const unknown = t.project(state(rs, 'completedSuccess'), 1);
  assert.ok(!unknown.some(d => d.kind === 'turn.boundary'));
  const end = state([], 'completedSuccess'); end.control.phase = 'error'; // Pinned OSS enum, synthetic negative fixture.
  const final = t.project(end, 1); assert.equal(final.at(-1).status, 'failed'); verified([...first, ...unknown, ...final]);
});
test('B-11 early acceptance/headerless active later adopts real header without duplicate open or identity loss', () => {
  for (const early of ['acceptance', 'headerless']) {
    const t = make(), rs = running(), c = inputs(rs);
    const first = early === 'acceptance' ? t.project(state([]), 1, c) : t.project(state(rs.slice(1)), 1);
    const second = t.project(state(rs), 1, c);
    rs[0].state = 'completedSuccess';
    const final = t.project(state(rs, 'completedSuccess'), 1, c);
    const ds = [...first, ...second, ...final];
    assert.equal(ds.filter(d => d.kind === 'turn.open').length, 1);
    assert.equal(ds.filter(d => d.kind === 'input.accepted').length, 1);
    assert.equal(ds.filter(d => d.kind === 'turn.boundary').length, 1); verified(ds);
  }
});
test('B-12 2200 zero-work turns retire; synthetic positions never corrupt native watermark or checkpoint', () => {
  const t = make(), c = new api.CommandCorrelation();
  t.project(snapshot(rows('native-history', 100)), 1, inputs(rows('native-history', 100)));
  for (let i = 0; i < 2200; i++) {
    c.begin('zero' + i, 'creq_2222222222', 1, 10); c.authoritative('zero' + i, 1, 'inputAccepted', 'zero-turn' + i);
    const ds = t.project(state([], 'completedSuccess'), 1, c);
    assert.deepEqual(ds.map(d => d.kind), ['turn.open', 'input.accepted', 'turn.boundary']);
  }
  const cp = t.checkpoint(), restored = make(); restored.restore(cp);
  assert.ok(JSON.parse(cp).turns.length <= 256);
  assert.deepEqual(restored.project(state([], 'completedSuccess'), 1), []);
});
test('B-13 replacement also closes accepted input before first projection, no acceptance silently lost', async () => {
  const { l, messages } = lifecycle(), c = inputs([rows()[0]]);
  await l.replaced('session1', 'epoch1', 2, true, c);
  assert.deepEqual(messages[0].params.deltas.map(d => d.kind), ['turn.open', 'input.accepted', 'turn.boundary']);
  assert.equal(c.acceptance('command-turn1', 1), null); verifiedMessages(messages);
});
