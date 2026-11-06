import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startBalance, decodeStartBalance } from '../../src/start-plan.ts';

const ids = ['GLM-5.3-Flash', 'GLM-5.3'];
test('real claimed plan-only response is pending, never a fabricated bucket or absent grant', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/m515-pending-balance.json', import.meta.url), 'utf8'));
  const now = 1793967815976, server = 1793967814000;
  const value = startBalance(fixture, ids, now, server);
  assert.equal(value.granted, true); assert.equal(value.entitlement, undefined);
  assert.equal(value.validUntil, now + 1793977200000 - server);
  assert.equal(value.usage.status, 'ok');
  assert.match(value.usage.planLabel, /pending activation.*2026-11-06 15:00:00 UTC/);
  assert.deepEqual(value.usage.windows, [], 'grant_units is not a reported available/remaining bucket');
  assert.deepEqual(decodeStartBalance(JSON.parse(JSON.stringify(value))), value);
  // Passing an activation time alone never manufactures a bucket or model.
  assert.equal(startBalance(fixture, ids, 1793977200000, 1793977200000).entitlement, undefined);
});
test('claimed plan with no reported bucket stays granted at/after effective start until actual expiry', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/m515-pending-balance.json', import.meta.url), 'utf8'));
  for (const server of [1793977200000, 1793979000000, 1794185999999]) {
    fixture.data.server_time = server / 1000;
    const value = startBalance(fixture, ids, server);
    assert.equal(value.granted, true);
    assert.equal(value.entitlement, undefined);
    assert.equal(value.usage.status, 'ok');
    assert.match(value.usage.planLabel, /claimed.*balance.*not.*reported/i);
    assert.doesNotMatch(value.usage.planLabel, /No active|pending/i);
    assert.deepEqual(value.usage.windows, []);
    assert.deepEqual(decodeStartBalance(JSON.parse(JSON.stringify(value))), value);
  }
  assert.equal(startBalance(fixture, ids, 1794186000000, 1794186000000).usage.status, 'expired');
  assert.match(startBalance({ code: 0, data: { plans: [], balances: [] } }, ids).usage.planLabel, /No active/);
});
const grant = () => ({ code: 0, data: { server_time: 1000,
  plans: [{ user_plan_id: 'owned', plan_id: 'weekend', status: 'active', starts_at: 900, ends_at: 3000,
    entitlements: [{ entitlement_id: 'flash', effective_at: 2000 }] }],
  balances: [{ user_plan_id: 'owned', plan_id: 'weekend', entitlement_id: 'flash', period_start: 2000,
    period_end: 3000, meter: 'model_usage', unit_type: 'token', capabilities: ['model:glm-5.3-flash'],
    total_units: 500000000, used_units: 0, remaining_units: 500000000, available_units: 500000000 }] } });

test('future Start grant is successful pending Usage, with no early model; exact start/end use server time', () => {
  const b = grant();
  for (const server of [1000000, 1999999]) {
    const value = startBalance(b, ids, 9000000, server);
    assert.equal(value.entitlement, undefined);
    assert.equal(value.usage.status, 'ok');
    assert.match(value.usage.planLabel, /pending/i);
    assert.match(value.usage.windows[0].label, /500,000,000/);
    assert.match(value.usage.windows[0].label, /1970-01-01 00:33:20 UTC/);
  }
  for (const server of [2000000, 2999999])
    assert.deepEqual(startBalance(b, ids, 9000000, server).entitlement.modelIds, ['GLM-5.3-Flash']);
  assert.equal(startBalance(b, ids, 9000000, 3000000).usage.status, 'expired');
  assert.equal(startBalance(b, ids, 9000000, 3000000).entitlement, undefined);
  const unknownAmount = grant(); delete unknownAmount.data.balances[0].total_units;
  assert.equal(startBalance(unknownAmount, ids, 1000000).usage.status, 'ok');
  assert.match(startBalance(unknownAmount, ids, 1000000).usage.planLabel, /pending/);
  assert.equal(startBalance(unknownAmount, ids, 2000000, 2000000).usage.status, 'error');
});

test('each associated lower boundary applies independently; unrelated plan or entitlement cannot delay a bucket', () => {
  for (const source of ['period_start', 'starts_at', 'effective_at']) {
    const b = grant();
    delete b.data.balances[0].period_start;
    delete b.data.plans[0].starts_at;
    delete b.data.plans[0].entitlements[0].effective_at;
    if (source === 'period_start') b.data.balances[0].period_start = 2000;
    if (source === 'starts_at') b.data.plans[0].starts_at = 2000;
    if (source === 'effective_at') b.data.plans[0].entitlements[0].effective_at = 2000;
    assert.equal(startBalance(b, ids, 1000000).entitlement, undefined, source);
  }
  const b = grant(); delete b.data.balances[0].period_start;
  b.data.plans[0].entitlements[0].entitlement_id = 'other';
  b.data.plans.push({ user_plan_id: 'someone-else', plan_id: 'weekend', status: 'active', starts_at: 2500 });
  assert.deepEqual(startBalance(b, ids, 1000000).entitlement.modelIds, ['GLM-5.3-Flash']);
});

test('pending, missing, error, unknown dates and mixed current buckets remain distinct', () => {
  assert.throws(() => startBalance({ code: 500 }, ids));
  assert.match(startBalance({ code: 0, data: {} }, ids).usage.planLabel, /No active/);
  const b = grant(); delete b.data.balances[0].period_start; delete b.data.plans[0].starts_at;
  delete b.data.plans[0].entitlements[0].effective_at;
  assert.deepEqual(startBalance(b, ids, 1000000).entitlement.modelIds, ['GLM-5.3-Flash']);
  const mixed = grant();
  mixed.data.balances.push({ ...mixed.data.balances[0], user_plan_id: 'current', plan_id: 'current',
    entitlement_id: 'current', period_start: 900, capabilities: ['model:glm-5.3'] });
  assert.deepEqual(startBalance(mixed, ids, 1000000).entitlement.modelIds, ['GLM-5.3']);
  const planOnly = grant(); planOnly.data.balances = [];
  planOnly.data.plans.push({ plan_id: 'old', status: 'expired', ends_at: 500 });
  const pending = startBalance(planOnly, ids, 1000000);
  assert.equal(pending.usage.status, 'ok'); assert.match(pending.usage.planLabel, /pending/);
  assert.equal(pending.entitlement, undefined); assert.equal(pending.granted, true);
});
