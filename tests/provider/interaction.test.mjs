import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers.mjs';
test('M4 closed question + accepted late ACK leaves state/answer unchanged and creates no dispatch', () => {
  const a = new api.InteractionArbiter(); a.observe('question1', 1, { visibleAt: 10, deadlineAt: 300 });
  assert.equal(a.resolve('question1', 1, { answers: {} }), true); // authoritative native auto-resolution
  const before = a.inspect('question1', 1), effects = [];
  if (a.propose('question1', 1, 'v4', { answers: { q: 'late' } })) effects.push('dispatch');
  assert.equal(a.ack('question1', 1, true), true); assert.deepEqual(a.inspect('question1', 1), before);
  assert.deepEqual(effects, []); assert.equal(a.resolve('question1', 1, { answers: { q: 'late' } }), false);
});
test('two channels deduplicate; ACK never applies proposed answer; native result wins', () => {
  const a = new api.InteractionArbiter(); a.observe('question1', 1);
  assert.equal(a.propose('question1', 1, 'reverseRpc', 'human'), true);
  assert.equal(a.propose('question1', 1, 'v4', 'duplicate'), false);
  const before = a.inspect('question1', 1);
  a.ack('question1', 1, true); assert.deepEqual(a.inspect('question1', 1), before); assert.equal(before.applied, undefined);
  assert.equal(a.resolve('question1', 1, 'native'), true); assert.equal(a.inspect('question1', 1).applied, 'native');
  assert.equal(a.resolve('question1', 1, 'duplicate'), false);
});
test('cancel and generation/interaction IDs guard late, duplicate, and unrelated callbacks', () => {
  const a = new api.InteractionArbiter(); a.observe('question1', 2);
  assert.equal(a.resolve('question1', 1, 'stale'), false); assert.equal(a.ack('question1', 1, true), false);
  assert.equal(a.propose('other', 2, 'v4', 'wrong'), false);
  assert.equal(a.cancel('question1', 2), true); const before = a.inspect('question1', 2);
  assert.equal(a.propose('question1', 2, 'reverseRpc', 'late'), false); assert.equal(a.resolve('question1', 2, 'late'), false);
  a.ack('question1', 2, true); assert.deepEqual(a.inspect('question1', 2), before);
  assert.equal(a.cancel('question1', 2), false);
});
test('native visibleAt/deadlineAt first observations survive repeated callbacks; absent remains absent', () => {
  const a = new api.InteractionArbiter(); a.observe('question1', 1); assert.equal(a.inspect('question1', 1).deadlineAt, undefined);
  a.observe('question1', 1, { visibleAt: 10 }); a.observe('question1', 1, { visibleAt: 20, deadlineAt: 100 });
  a.observe('question1', 1, { visibleAt: 30, deadlineAt: 200 });
  assert.equal(a.inspect('question1', 1).visibleAt, 10); assert.equal(a.inspect('question1', 1).deadlineAt, 100);
  const copy = a.inspect('question1', 1); copy.visibleAt = 999; assert.equal(a.inspect('question1', 1).visibleAt, 10);
});
test('RPC ACK/input acceptance/unknown admission timeout are independent; no silent command retries', () => {
  const c = new api.CommandCorrelation(); c.begin('command1', 'creq_2222222222', 1, 10);
  assert.equal(c.ack('command1', 0), false); assert.equal(c.ack('command1', 1), true);
  assert.equal(c.acceptance('command1', 1), null); c.expire(10); assert.equal(c.status('command1'), 'unknown');
  assert.throws(() => c.begin('command1', 'creq_2222222222', 1, 20), /duplicate-command/);
  assert.equal(c.authoritative('command1', 0, 'inputAccepted', 'turn1'), false);
  assert.equal(c.authoritative('command1', 1, 'inputAccepted', 'turn1'), true);
  assert.deepEqual(c.acceptance('command1', 1), { clientRequestId: 'creq_2222222222', providerTurnId: 'turn1' });
  assert.equal(c.authoritative('command1', 1, 'rejected'), false);
  c.begin('command2', 'creq_3333333333', 1, 10); c.authoritative('command2', 1, 'rejected'); assert.equal(c.acceptance('command2', 1), null);
});
test('durable session handle restores only its namespace and never creates replacement context', () => {
  const id = { namespace: 'host-data1', sessionId: 'session1' }, encoded = api.encodeIdentity(id);
  assert.deepEqual(api.restoreIdentity(encoded, id.namespace), id);
  assert.throws(() => api.restoreIdentity(encoded, 'other'), /resume-identity/);
  assert.throws(() => api.restoreIdentity('missing-session', id.namespace), /resume-identity/);
});
test('advancing generation invalidates previously pending interactions and commands', () => {
  const a = new api.InteractionArbiter(); a.observe('question1', 1); a.propose('question1', 1, 'v4', 'old');
  a.observe('question1', 2);
  assert.equal(a.resolve('question1', 1, 'stale'), false); assert.equal(a.ack('question1', 1, true), false);
  assert.equal(a.inspect('question1', 1).state, 'cancelled'); assert.equal(a.inspect('question1', 2).state, 'pending');
  assert.throws(() => a.observe('other', 1), /stale/);
  const c = new api.CommandCorrelation(); c.begin('old-command', 'old-input', 1, 100); c.begin('new-command', 'new-input', 2, 100);
  assert.equal(c.ack('old-command', 1), false); assert.equal(c.authoritative('old-command', 1, 'inputAccepted', 'old-turn'), false);
  assert.equal(c.acceptance('old-command', 1), null); assert.equal(c.status('old-command'), 'unknown');
});
