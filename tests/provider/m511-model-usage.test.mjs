import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { api, plugin } from './helpers.mjs';
import { startBalance } from '../../src/start-plan.ts';
import { selectedModel } from '../../src/model-selection.ts';
import { registerUsageSource, usageList, usageGet } from '../../src/usage-source.ts';
const coding = 'account:zai-individual-coding-plan', start = 'account:zai-start-plan';
test('M5.12 real post-deadline absent response is successful empty Usage, not expired or a collection error', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/m512-absent-balance.json', import.meta.url), 'utf8'));
  const result = startBalance(fixture, ['GLM-5.3-Flash'], 1793948755436, 1793948755000);
  assert.equal(result.entitlement, undefined);
  assert.deepEqual(result.usage, { status: 'ok', accountEmail: null,
    planLabel: 'No active Start Plan promotion · Coding Plan is separate', windows: [] });
  assert.throws(() => startBalance({ code: 401, data: fixture.data }, ['GLM-5.3-Flash']), /rejected/);
});
const envelope = (now = 1000000) => ({ code: 0, data: { server_time: now / 1000,
  plans: [{ user_plan_id: 'fixture-plan', plan_id: 'fixture', status: 'active', ends_at: now / 1000 + 3600 }],
  balances: [{ user_plan_id: 'fixture-plan', plan_id: 'fixture', meter: 'model_usage', unit_type: 'token',
    capabilities: ['model:glm-5.3-flash'], total_units: 300000000, used_units: 7015039, remaining_units: 292984961,
    available_units: 292984961, expires_at: now / 1000 + 3600 }] } });

test('native-derived Start token window has remaining/total, used percentage and associated expiry, not a time/cost window', () => {
  const b = envelope(), value = startBalance(b, ['GLM-5.3-Flash'], 1000000);
  assert.deepEqual(value.entitlement, { modelIds: ['GLM-5.3-Flash'], validUntil: 4600000 });
  assert.equal(value.usage.status, 'ok'); assert.equal(value.usage.planLabel, 'Start Plan');
  assert.equal(value.usage.windows.length, 1);
  const w = value.usage.windows[0];
  assert.match(w.label, /292,984,961 \/ 300,000,000 tokens remaining/);
  assert.match(w.label, /Start access expires/); assert.equal(w.usedPercent, 2.34);
  assert.match(w.label, /1970-01-01 01:16:40 UTC/);
  assert.ok(Math.abs(w.usedPercent - 100 * 7015039 / 300000000) < 0.005);
  assert.equal(w.resetsAt, new Date(4600000).toISOString()); assert.equal(w.cost, undefined);
  b.data.balances[0].expires_at = 3000;
  assert.equal(startBalance(b, ['GLM-5.3-Flash'], 1000000).usage.windows[0].resetsAt, new Date(3000000).toISOString());
  b.data.balances.push({ ...b.data.balances[0], user_plan_id: 'older', plan_id: 'older', expires_at: 999, capabilities: ['model:GLM-5.2'] });
  assert.equal(startBalance(b, ['GLM-5.3-Flash', 'GLM-5.2'], 1000000).usage.windows.length, 1);
  assert.deepEqual(startBalance(b, ['GLM-5.3-Flash', 'GLM-5.2'], 1000000).entitlement.modelIds, ['GLM-5.3-Flash']);
});

test('expired, absent, exhausted, reserved, unknown amount/unit and server clock are distinct without invented values (synthetic)', () => {
  const ids = ['GLM-5.3-Flash'];
  assert.equal(startBalance(envelope(), ids, 1000000, 5000000).usage.status, 'expired');
  assert.equal(startBalance(envelope(), ids, 1000000, 5000000).entitlement, undefined);
  const absent = startBalance({ code: 0, data: {} }, ids, 1000000);
  assert.equal(absent.entitlement, undefined); assert.equal(absent.usage.status, 'ok');
  assert.deepEqual(absent.usage.windows, []); assert.match(absent.usage.planLabel, /No active Start Plan promotion/);
  const zero = envelope(); Object.assign(zero.data.balances[0], { used_units: 300000000, remaining_units: 0, available_units: 0 });
  const exhausted = startBalance(zero, ids, 1000000);
  assert.equal(exhausted.entitlement, undefined); assert.equal(exhausted.usage.windows[0].usedPercent, 100);
  const reserved = envelope(); reserved.data.balances[0].available_units = 0;
  assert.equal(startBalance(reserved, ids, 1000000).entitlement, undefined);
  assert.match(startBalance(reserved, ids, 1000000).usage.windows[0].label, /292,984,961/);
  for (const patch of [{ total_units: undefined }, { used_units: undefined }, { remaining_units: null }, { unit_type: 'usd' }, { total_units: 0 }, { used_units: 300000001 }]) {
    const b = envelope(); Object.assign(b.data.balances[0], patch);
    const u = startBalance(b, ids, 1000000).usage;
    assert.equal(u.status, 'error'); assert.match(u.message, /amount unavailable/); assert.equal(u.windows, undefined);
  }
  const unknownExpiry = envelope(); delete unknownExpiry.data.plans[0].ends_at; delete unknownExpiry.data.balances[0].expires_at;
  assert.equal(startBalance(unknownExpiry, ids, 1000000).usage.windows[0].resetsAt, null);
  for (const code of [401, 403, 500]) assert.throws(() => startBalance({ code }, ids));
});

test('bb model namespace selects plan, key mismatch fails, global plan option is gone and Coding IDs are unchanged', async () => {
  assert.deepEqual(selectedModel('start-plan/GLM-5.3-Flash'), { model: 'GLM-5.3-Flash', accountPlan: 'start-plan' });
  assert.deepEqual(selectedModel('GLM-5.3-Flash'), { model: 'GLM-5.3-Flash', accountPlan: 'coding-plan' });
  assert.throws(() => selectedModel('start-plan/')); assert.throws(() => selectedModel('start-plan/x/y'));
  const full = { permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null };
  assert.throws(() => api.executionOptions({ ...full, model: 'start-plan/GLM-5.3-Flash', providerOptions: { authMode: 'coding-plan-key' } }), /requires Desktop/);
  assert.throws(() => api.executionOptions({ ...full, providerOptions: { accountPlan: 'start-plan' } }), /providerOptions/);
  let declaration, settings;
  await plugin({ settings: { define: schema => { settings = schema; return { get: async () => ({}), onChange() {} }; } }, providers: { register: p => { declaration = p; } } });
  assert.equal(settings.accountPlan, undefined); assert.equal(declaration.maintenance.usage, true);
  assert.equal(declaration.deriveProviderOptions({ settings: {} }).accountPlan, undefined);
  assert.match(declaration.strings.expiredHint, /Start Plan access/);
});

test('mixed runtime catalogue shares pending balance with Usage, refreshes amount, and preserves Coding on exhausted/expired/failed Start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'm511-catalogue-')), builtin = join(root, 'builtin.json'), credentials = join(root, 'credentials.json');
  writeFileSync(builtin, '{"models":["GLM-5.3","GLM-5.3-Flash"]}');
  writeFileSync(credentials, JSON.stringify({ zcodejwttoken: 'FAKE_JWT', [`account-provider:${coding}:identity`]: 'fixture',
    [`account-provider:${coding}:auth-source`]: 'manual', [`account-provider:coding-plan:${coding}:account:fixture:api-key`]: 'FAKE_KEY' }));
  let fetches = 0, state = 'active';
  const runtime = api.createNativeServices(join(root, 'runtime'), { auth: new api.ReadOnlyAuth(credentials),
    paths: { executable: process.execPath, script: resolve('tests/provider/fake-v4.mjs'), builtin },
    discovery: () => ({ installed: true, supported: true, sha256: 'fixture', version: 'fixture' }), compatibility: () => ({ message: null }),
    startOffer: async () => ({ offers: [] }),
    startSnapshot: async auth => {
      fetches++; auth.read('fixture-balance'); await new Promise(r => setTimeout(r, 30));
      if (state === 'failed') throw Error('PRIVATE_REMOTE_BODY');
      const b = envelope(Date.now());
      if (state === 'exhausted') Object.assign(b.data.balances[0], { available_units: 0, remaining_units: 0, used_units: 300000000 });
      if (state === 'expired') b.data.plans[0].status = 'expired';
      if (state === 'absent') b.data = {};
      return startBalance(b, ['GLM-5.3', 'GLM-5.3-Flash']);
    },
    configure: async child => {
      const original = child.request.bind(child);
      child.request = async (method, params) => method === 'session/create' ? { settings: { model: {
        current: { providerId: start, modelId: 'GLM-5.3-Flash' },
        available: [[coding, 'GLM-5.3'], [coding, 'GLM-5.3-Flash'], [start, 'GLM-5.3-Flash']].map(([providerId, modelId]) => ({ ref: { providerId, modelId }, label: modelId,
          reasoning: { levels: ['low', 'high', 'max'].map(value => ({ value })), defaultLevel: 'max' } })) } } } : original(method, params);
    } });
  try {
    const [catalogue, u] = await Promise.all([runtime.services.catalogue(), runtime.services.usage()]);
    assert.equal(fetches, 1); assert.equal(u.usage.status, 'ok');
    assert.deepEqual(catalogue.models.map(m => m.model), ['GLM-5.3', 'GLM-5.3-Flash', 'start-plan/GLM-5.3-Flash']);
    assert.deepEqual(catalogue.models.filter(m => m.isDefault).map(m => m.model), ['GLM-5.3']);
    assert.equal(catalogue.models[2].displayName, 'GLM-5.3-Flash · Start Plan');
    await runtime.services.catalogue(); assert.equal(fetches, 1);
    for (const stateValue of ['exhausted', 'expired', 'absent']) {
      state = stateValue; runtime.services.invalidateCatalogue(); await runtime.services.usage();
      assert.deepEqual((await runtime.services.catalogue()).models.map(m => m.model), ['GLM-5.3', 'GLM-5.3-Flash']);
      await assert.rejects(runtime.services.validateSelection('GLM-5.3-Flash', 'high', 'desktop', 'start-plan'), /no entitled/);
      assert.equal((await runtime.services.health()).health.status, 'ready');
    }
    runtime.services.invalidateCatalogue(); state = 'failed';
    assert.deepEqual((await runtime.services.catalogue()).models.map(m => m.model), ['GLM-5.3', 'GLM-5.3-Flash']);
    const failed = await runtime.services.usage(); assert.equal(failed.usage.status, 'error'); assert.ok(!JSON.stringify(failed).includes('PRIVATE_REMOTE_BODY'));
    state = 'active'; runtime.services.invalidateCatalogue(); const before = fetches;
    const [a, b] = await Promise.all([runtime.services.usage(), runtime.services.usage()]);
    assert.deepEqual(a, b); assert.equal(fetches, before + 1);
    assert.equal((await runtime.services.catalogue()).models.length, 3);
  } finally { await runtime.close(); rmSync(root, { recursive: true }); }
});

test('provider/usage bridge forwards the real maintenance result without a session or model send', async () => {
  const out = []; let calls = 0;
  const bridge = api.createZCodeBridge({ usage: async () => { calls++; return { supported: true, usage: { status: 'expired' } }; } }, m => out.push(m));
  try {
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'provider/usage', params: {} }));
    for (let i = 0; i < 100 && !out.some(m => m.id === 1); i++) await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(out.find(m => m.id === 1).result, { supported: true, usage: { status: 'expired' } });
    assert.equal(calls, 1);
  } finally { await bridge.close(); }
});

test('installed Usage discovery inventory is metadata-only; resource relay is host/provider scoped and exports validated JSON schemas', async () => {
  let handlers, contract, options, collections = 0, state = 'ok';
  registerUsageSource({ pluginId: 'own', rpc: { register: (c, h, o) => { contract = c; handlers = h; options = o; } }, sdk: {
    hosts: { list: async () => [{ id: 'host-own', name: 'Fixture host' }] },
    providers: { list: async () => [{ id: 'own-provider', pluginId: 'own' }, { id: 'another-provider', pluginId: 'other' }] },
    system: { usageLimits: async args => { assert.deepEqual(args, { hostId: 'host-own', providerId: 'own-provider', refresh: true }); collections++;
      if (state === 'failed') throw Error('PRIVATE_REMOTE');
      return { 'own-provider': state === 'ok' ? startBalance(envelope(), ['GLM-5.3-Flash'], 1000000).usage : { status: state } }; } },
  } }, 'own-provider');
  const inventory = await handlers[usageList]({});
  assert.equal(collections, 0); assert.equal(inventory.resources.length, 2); assert.equal(inventory.resources[0].accountKey, null);
  assert.equal(options.experimental_discoverable, true);
  for (const method of [usageList, usageGet]) for (const side of ['input', 'output']) {
    const json = contract[method][side]['~standard'].jsonSchema[side]({ target: 'draft-2020-12' });
    assert.equal(json.type, 'object'); assert.ok(JSON.stringify(json).length > 20);
  }
  const id = inventory.resources.find(r => r.label === 'Start Plan').id;
  await assert.rejects(handlers[usageGet]({ resourceId: '["other-host","own-provider"]', refresh: true }), /no longer exists/);
  assert.equal(collections, 0);
  let lastObserved;
  for (const status of ['ok', 'expired', 'unauthenticated', 'failed']) {
    state = status; const value = await handlers[usageGet]({ resourceId: id, refresh: true });
    const validation = contract[usageGet].output['~standard'].validate(value);
    assert.equal(validation.issues, undefined, JSON.stringify(validation));
    assert.equal(value.accountKey, null); assert.equal(value.usage.plan, null);
    assert.equal(value.usage.status, status === 'failed' ? 'error' : status);
    if (status === 'ok') { lastObserved = value.observedAt; assert.ok(lastObserved > 0); assert.equal(value.usage.windows[0].cost, null); }
    else assert.equal(value.observedAt, lastObserved);
    assert.ok(!JSON.stringify(value).includes('PRIVATE_REMOTE'));
  }
  assert.ok(contract[usageGet].input['~standard'].validate({ resourceId: id, refresh: 'true' }).issues);
  assert.ok(contract[usageList].input['~standard'].validate({ unknown: true }).issues);
});
