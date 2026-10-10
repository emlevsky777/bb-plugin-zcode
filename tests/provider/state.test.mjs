import test from 'node:test';
import assert from 'node:assert/strict';
import { api, snapshot, frame, delta, rows, inputs } from './helpers.mjs';
function state() { const s = new api.ConversationState(() => {}); s.attach(1, 'session1', 'subscription1'); return s; }
test('snapshot/delta application and sequence/row duplicates do not append twice', () => {
  const s = state(), rs = rows(); s.ingest(frame(snapshot(rs)), 1);
  const d = delta([{ op: 'row.appended', row: rs[0] }, { op: 'row.delta', rowId: 2, path: 'text', append: '!' }]);
  assert.equal(s.ingest(d, 1), 'applied'); assert.equal(s.snapshot.rows.window.length, 3);
  assert.equal(s.snapshot.rows.window[1].text, 'text-turn1!');
  assert.equal(s.ingest(d, 1), 'duplicate'); assert.equal(s.snapshot.rows.window[1].text, 'text-turn1!');
  const copy = s.snapshot; copy.rows.window.length = 0; assert.equal(s.snapshot.rows.window.length, 3);
});
test('state.updated replaces whole keys and row upsert/unloaded stream matches upstream', () => {
  const s = state(), initial = snapshot(rows()); initial.control = { a: 1, b: 2 }; s.ingest(frame(initial), 1);
  s.ingest(delta([{ op: 'state.updated', patch: { control: { a: 9 } } },
    { op: 'row.upserted', row: { ...rows()[1], text: 'updated' } },
    { op: 'row.upserted', row: { ...rows()[1], rowId: 100 } },
    { op: 'row.delta', rowId: 999, path: 'text', append: 'absent' }]), 1);
  assert.deepEqual(s.snapshot.control, { a: 9 }); assert.equal(s.snapshot.rows.window.length, 3);
  assert.equal(s.snapshot.rows.window[1].text, 'updated');
});
test('gap/epoch/rewrite require recovery; stale generation/subscription cannot apply', () => {
  const s = state(); s.ingest(frame(snapshot(rows())), 1);
  assert.equal(s.ingest(delta([]), 0), 'stale');
  assert.equal(s.ingest({ ...delta([]), subscriptionId: 'old' }, 1), 'stale');
  assert.throws(() => s.ingest(delta([], 2, 3), 1), /sequence-gap/);
  assert.throws(() => s.ingest(delta([]), 1), /snapshot-required/);
  s.ingest(frame(snapshot(rows()), 0, 4), 1); assert.equal(s.requiresSnapshot, false);
  assert.throws(() => s.ingest(frame(snapshot(rows(), 'new'), 0, 5), 1), /epoch-changed/);
  s.attach(2, 'session1', 'subscription2');
  assert.equal(s.ingest(frame(), 1), 'stale');
  assert.equal(s.ingest({ ...frame(snapshot(rows(), 'new')), subscriptionId: 'subscription2' }, 2), 'applied');
  assert.throws(() => s.attach(2, 'session1', 'subscription3'), /generation/);
  assert.throws(() => s.ingest({ ...delta([{ op: 'row.removed', fromRowId: 1 }]), subscriptionId: 'subscription2' }, 2), /rewrite/);
});
test('a malformed late delta cannot partially commit', () => {
  const s = state(); s.ingest(frame(snapshot(rows())), 1); const before = s.snapshot;
  assert.throws(() => s.ingest(delta([{ op: 'row.delta', rowId: 2, path: 'text', append: 'bad' }, { op: 'row.appended', row: {} }]), 1));
  assert.deepEqual(s.snapshot, before); assert.equal(s.seq, 1);
});
test('ADR-002 unknown enum and unknown row preserve known data with visible warnings', () => {
  const warnings = [], s = new api.ConversationState(d => warnings.push(d.code)); s.attach(1, 'session1', 'subscription1');
  const rs = rows(); rs[2].status = 'future-status'; rs.push({ rowId: 9, kind: 'future-row', extra: 42 });
  const f = frame(snapshot(rs)); assert.equal(s.ingest(f, 1), 'applied');
  assert.equal(s.snapshot.rows.window[1].text, 'text-turn1'); assert.equal(s.snapshot.rows.window[3].extra, 42);
  assert.ok(warnings.includes('unknown-row-enum')); assert.ok(warnings.includes('unknown-row-kind'));
  const t = new api.EventTranslator('session1', 'epoch1', 1, d => warnings.push(d.code));
  const ds = t.project(s.snapshot, 1, inputs(rs)); assert.ok(ds.some(d => d.kind === 'item.textDelta' && d.text === 'text-turn1'));
  assert.equal(ds.find(d => d.kind === 'item.close').status, 'failed'); // unknown tool outcome does not invent tool success
  assert.ok(ds.some(d => d.kind === 'turn.boundary')); // authoritative terminal still settles the accepted input
});
test('ADR-002 separate unknown-row fixture keeps known text and terminal in real SDK translation', () => {
  const warnings = [], rs = rows(); rs.push({ rowId: 10, kind: 'future-row-type' });
  const s = api.parseFrame(frame(snapshot(rs)), d => warnings.push(d.code));
  const ds = new api.EventTranslator('session1', 'epoch1', 1, d => warnings.push(d.code)).project(s.payload.snapshot, 1, inputs(rs));
  assert.ok(warnings.includes('unknown-row-kind'));
  assert.ok(ds.some(d => d.kind === 'item.textDelta' && d.text === 'text-turn1'));
  assert.ok(ds.some(d => d.kind === 'turn.boundary' && d.status === 'completed'));
});
