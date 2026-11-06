import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codingQuota, codingSubscription, collectCodingUsage } from '../../src/coding-usage.ts';
import { ReadOnlyAuth } from '../../src/auth.ts';
import { registerUsageSource, usageList, usageGet, usageMeasurement } from '../../src/usage-source.ts';
const envelope = data => ({ code: 200, success: true, data });
const active = envelope([{ productId: 'coding-plan', status: 'VALID', inCurrentPeriod: true }]);
const quota = (percentage = 20) => envelope({ limits: [
  { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage, nextResetTime: 1800000000000, usage: 10, currentValue: 3 },
  { type: 'CREDIT_LIMIT', unit: 6, number: 1, percentage: 40 },
  { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 60 },
] });
test('native Coding windows use percentages, preserve resets, distinguish monthly tools and never treat duration as a token amount', () => {
  const u = codingQuota(quota(100)); assert.equal(u.status, 'ok'); assert.equal(u.windows.length, 3);
  assert.equal(u.windows[0].usedPercent, 100); assert.equal(u.windows[0].resetsAt, new Date(1800000000000).toISOString());
  assert.match(u.windows[1].label, /Weekly model/); assert.match(u.windows[2].label, /Monthly MCP \/ tools/);
  assert.equal(u.windows[1].resetsAt, null); assert.ok(!JSON.stringify(u).includes('tokens'));
  for (const p of [-1, 101, null, '20', NaN]) assert.equal(codingQuota(quota(p)).status, 'error');
  for (const v of [envelope({ limits: [] }), envelope({}), envelope({ limits: [{ type: 'NEW', percentage: 5 }] })]) assert.equal(codingQuota(v).status, 'error');
  assert.throws(() => codingQuota({ code: 500, data: {} }));
});
test('successful subscription absence differs from expired, unknown and rejected payloads', () => {
  assert.equal(codingSubscription(active), 'active'); assert.equal(codingSubscription(envelope([])), 'absent');
  assert.equal(codingSubscription(envelope([{ productName: 'Coding', status: 'EXPIRED', inCurrentPeriod: false }])), 'expired');
  assert.equal(codingSubscription(envelope([{ productName: 'Coding', status: 'VALID', inCurrentPeriod: false }])), 'absent');
  assert.equal(codingSubscription(envelope([{ productId: 'coding-plan' }])), 'unknown');
  assert.equal(codingSubscription(envelope({})), 'unknown'); assert.throws(() => codingSubscription({ code: 403 }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'm514-')), path = join(root, 'credentials.json');
  const store = key => ({ 'account-provider:account:zai-individual-coding-plan:identity': 'fixture',
    'account-provider:account:zai-individual-coding-plan:auth-source': 'manual',
    'account-provider:coding-plan:account:zai-individual-coding-plan:account:fixture:api-key': key });
  writeFileSync(path, JSON.stringify(store('fixture-key')));
  return { root, path, store, auth: new ReadOnlyAuth(path), close: () => rmSync(root, { recursive: true, force: true }) };
}
test('two consumers share pending and successful requests, invalidate on credential/version/source change, no promotion or model requests', async () => {
  const f = fixture(); let calls = [];
  try {
    const send = async (url, method, headers) => { calls.push({ url, method, headers }); return url.endsWith('/list') ? active : quota(); };
    const options = { root: f.root, version: '3.17.2', auth: f.auth, send };
    const [a, b] = await Promise.all([collectCodingUsage(options), collectCodingUsage(options)]);
    assert.equal(calls.length, 2); assert.deepEqual(a, b); assert.equal(a.usage.status, 'ok');
    assert.deepEqual(await collectCodingUsage(options), a); assert.equal(calls.length, 2);
    assert.ok(calls.every(c => c.method === 'GET' && c.headers.authorization === 'fixture-key'));
    writeFileSync(f.path, JSON.stringify(f.store('rotated-fixture')));
    await collectCodingUsage(options); assert.equal(calls.length, 4); assert.equal(calls[2].headers.authorization, 'rotated-fixture');
    await collectCodingUsage({ ...options, version: '3.18.0' }); assert.equal(calls.length, 6);
    const key = join(f.root, 'key'); writeFileSync(key, 'explicit-fixture', { mode: 0o600 });
    await collectCodingUsage({ root: f.root, version: '3.17.2', mode: 'coding-plan-key', keyPath: key, send });
    assert.equal(calls.length, 8); assert.equal(calls[6].headers.authorization, 'explicit-fixture');
    assert.ok(calls.every(c => /\/api\/(biz\/subscription\/list|monitor\/usage\/quota\/limit)$/.test(c.url)));
    assert.ok(!readFileSync(join(f.root, 'discovery-coding-usage.json'), 'utf8').includes('fixture-key'));
  } finally { f.close(); }
});
test('partial backend failures never infer absence/zero; absent subscription avoids unnecessary quota GET; failures share first native 30s interval', async () => {
  for (const state of ['sub-failed', 'quota-failed', 'both-failed', 'absent', 'expired', 'unknown']) {
    const f = fixture(); let calls = 0;
    try {
      const options = { root: f.root, version: '3.17.2', auth: f.auth, send: async url => {
        calls++;
        if (url.endsWith('/list')) {
          if (state.includes('failed') && state !== 'quota-failed') throw Error('PRIVATE_BODY');
          return state === 'absent' ? envelope([]) : state === 'expired' ? envelope([{ productId: 'coding', status: 'EXPIRED', inCurrentPeriod: false }]) : state === 'unknown' ? envelope({}) : active;
        }
        if (state === 'quota-failed' || state === 'both-failed') throw Error('PRIVATE_BODY');
        return quota();
      } };
      const u = await collectCodingUsage(options), second = await collectCodingUsage(options);
      assert.deepEqual(second, u); assert.equal(calls, ['absent', 'expired'].includes(state) ? 1 : 2);
      assert.equal(u.usage.status, ['quota-failed', 'both-failed'].includes(state) ? 'error' : 'ok');
      assert.ok(!JSON.stringify(u).includes('PRIVATE_BODY'));
      if (state === 'absent') assert.match(u.usage.planLabel, /No active subscription/);
      if (u.usage.status === 'error') { assert.equal(u.observedAt, null); assert.equal(u.usage.windows, undefined); }
    } finally { f.close(); }
  }
});
test('in-flight account rotation rejects old measurement without retry or publication', async () => {
  const f = fixture(); let calls = 0;
  try {
    const u = await collectCodingUsage({ root: f.root, version: '3.17.2', auth: f.auth, send: async () => {
      calls++; writeFileSync(f.path, JSON.stringify(f.store('changed-in-flight'))); return active;
    } });
    assert.equal(u.usage.status, 'error'); assert.equal(calls, 1);
  } finally { f.close(); }
});
test('post-GET scope validation never resolves or refreshes project-token material again', async () => {
  const f = fixture(); let resolutions = 0;
  try {
    f.auth.usageAuthorization = async () => { assert.equal(++resolutions, 1); return 'fixture-key'; };
    const value = await collectCodingUsage({ root: f.root, version: '3.17.2', auth: f.auth,
      send: async url => url.endsWith('/list') ? active : quota() });
    assert.equal(value.usage.status, 'ok'); assert.equal(resolutions, 1);
  } finally { f.close(); }
});
test('public two-plan resource route keeps independent failures and observedAt, inventory invokes neither collector', async () => {
  let handlers, codingCalls = 0, startCalls = 0, codingFailed = false;
  registerUsageSource({ pluginId: 'own', rpc: { register: (_, h) => { handlers = h; } },
    hosts: { experimental_client: () => ({ call: async (method, input, opts) => {
      assert.equal(method, 'codingUsage'); assert.equal(input.mode, 'coding-plan-key'); assert.equal(opts.hostId, 'host'); codingCalls++;
      return usageMeasurement(codingFailed ? { status: 'error', message: 'Coding unavailable' } : codingQuota(quota()), codingFailed ? null : 1234);
    } }) }, sdk: { hosts: { list: async () => [{ id: 'host', name: 'Fixture host' }] }, providers: { list: async () => [{ id: 'provider', pluginId: 'own' }] },
      system: { usageLimits: async () => { startCalls++; return { provider: { status: 'ok', accountEmail: null, planLabel: 'Start Plan · No active promotion', windows: [] } }; } } } }, 'provider', async () => 'coding-plan-key');
  const inv = await handlers[usageList]({}); assert.equal(codingCalls + startCalls, 0); assert.equal(inv.resources.length, 2);
  const get = label => handlers[usageGet]({ resourceId: inv.resources.find(r => r.label === label).id, refresh: true });
  assert.equal((await get('Coding Plan')).observedAt, 1234); assert.equal(startCalls, 0);
  codingFailed = true; assert.equal((await get('Coding Plan')).usage.status, 'error'); assert.equal((await get('Coding Plan')).observedAt, 1234);
  assert.equal((await get('Start Plan')).usage.status, 'ok'); assert.equal(startCalls, 1);
});
