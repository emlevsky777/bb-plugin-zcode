import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Execute the installed native implementation in memory; no bundle copy,
// configuration write, hook installation or synthetic product threshold.
const source = readFileSync('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs', 'utf8');
const extract = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
};

test('G4 pinned CLI .16.9: native drains one guide per boundary in admission order; lost ACK is resolved by persisted source identity', async () => {
  assert.equal(createHash('sha256').update(source).digest('hex'), 'b816e38656e70fb585fe2ab1ea010da89cda928dac1ccb5d83255fd18796da6e');
  const choose = new Function(extract('function gAn(', 'function bLo(') + '; return vLo;')();
  let ordinal = 0;
  const drain = new Function('vLo', 'kSe', 'eZ', 'Ll', 'DSt', 'VSe', 'yie', 'xSe', 'nre', 'i8', 'nt', 'Sr', 'dP',
    extract('async function KFa(', 'async function LLo(') + '; return KFa;')(
    choose, x => x, x => x.length, () => 'message-' + ++ordinal, async () => [], x => x,
    (text, metadata) => ({ message: { role: 'user', content: text }, metadata }), x => x,
    x => x ? { inputPresentation: x } : undefined, () => ({ source: 'real_user' }),
    { TurnSteerDrained: 'turn_steer_drained' }, () => ({}), () => undefined);
  const pending = (id, input) => ({ id, input, delivery: 'guide', queuedAt: new Date(), intent: { sourceCommandId: id } });
  const turn = { turnId: 'main-turn', pendingInputs: [pending('real-user', 'user guidance'), pending('bb-service', 'frozen full bb block')] };
  const history = [], persisted = [], events = [];
  const runtime = { pendingInputReservations: new Set(), messageHistory: { addEntries: entries => history.push(...entries) },
    persistUserPrompt: async (id, text, attachments, trace, identity) => persisted.push({ id, text, ...identity }),
    createEvent: (type, payload) => ({ type, payload }), appendEvent: async () => {} };
  const first = await drain.call(runtime, { activeTurn: turn, events, traceContext: {} });
  assert.deepEqual(first.pendingInputIds, ['real-user']);
  assert.equal(turn.pendingInputs.length, 1);
  assert.equal(history.some(e => e.message.content === 'frozen full bb block'), false);
  // Even with an absent/lost command ACK, native persisted sourceCommandId
  // identifies the delivery. Re-read that outcome, never submit it again.
  let dispatches = 0, second;
  const dispatchWithLostAck = async () => {
    dispatches++;
    second = await drain.call(runtime, { activeTurn: turn, events, traceContext: {} });
    throw new Error('transport lost ACK after native persistence');
  };
  await assert.rejects(dispatchWithLostAck, /lost ACK/);
  assert.deepEqual(second.pendingInputIds, ['bb-service']);
  assert.equal(persisted.filter(p => p.sourceCommandId === 'bb-service').length, 1);
  assert.equal(persisted.find(p => p.sourceCommandId === 'bb-service').steerDelivery, 'guide');
  assert.equal(dispatches, 1);
  assert.equal(await drain.call(runtime, { activeTurn: turn, events, traceContext: {} }), undefined);
  assert.equal(history.filter(e => e.message.content === 'frozen full bb block').length, 1);
  assert.deepEqual(events.map(e => e.payload.pendingInputIds), [['real-user'], ['bb-service']]);
});

test('G4 native completion persists/emits success before runtime replacement; regular loop has no guide drain between auto compact and request', async () => {
  assert.equal(createHash('sha256').update(source).digest('hex'), 'b816e38656e70fb585fe2ab1ea010da89cda928dac1ccb5d83255fd18796da6e');
  const emit = new Function(extract('async function bBe(', 'function CPn(') + '; return bBe;')();
  const order = [], events = [];
  await emit({ persistCompactTimeline: async () => order.push('persist'), createEvent: () => ({ success: true }),
    appendEvent: async () => order.push('success') }, 'completed', {}, {}, events);
  assert.deepEqual(order, ['persist', 'success']);
  const completion = source.slice(source.indexOf('await bBe(this,nt.CompactCompleted,st'), source.indexOf('await bBe(this,nt.CompactCompleted,st') + 650);
  assert.ok(completion.indexOf('replaceMessages') > completion.indexOf('await bBe'));
  const loop = extract('async function B6o(', 'async function z6o(');
  const after = loop.slice(loop.indexOf('await this.autoCompactIfNeeded'), loop.indexOf('await R6o.call'));
  assert.ok(after.length > 0);
  assert.equal(after.includes('drainPendingInput'), false);
  assert.equal(after.includes('Uwt('), false);
  assert.ok(source.includes('if(await Uwt(this,e))'));
});
