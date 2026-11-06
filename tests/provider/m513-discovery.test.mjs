import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { api, plugin } from './helpers.mjs';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { readDiscovery, peekDiscovery } from '../../src/discovery-cache.ts';
import { startBalance } from '../../src/start-plan.ts';
import { fetchStartOffer, marketingStartOffer, startOfferContext, startClaimGuidance } from '../../src/start-offer.ts';
const offer = { offers: [{campaignId:'fixture-campaign',planId:'fixture-plan',position:'banner'}] };
const device = '00000000-0000-4000-8000-000000000001';
const telemetry = root => { mkdirSync(join(root,'.zcode/v2'),{recursive:true}); writeFileSync(join(root,'.zcode/v2/telemetry-state.json'),JSON.stringify({deviceMid:device})); };
const button = type => ({text:{format:'plaintext',content:'Fixture'},action:type==='claim_zcode_plan'?{type,args:{plan_id:'fixture-plan'}}:{type}});
const delivery = (position='banner',type='claim_zcode_plan',campaign='fixture-campaign') => ({campaign_id:campaign,priority:50,resource_position:position,[position]:position==='banner'?{background:{type:'image',image:{default:{src:'https://example.invalid/fixture.png',sha256:'a'.repeat(64)}}},buttons:[button(type)]}:{title:{format:'plaintext',content:'Fixture'},description:{format:'plaintext',content:'Fixture'},buttons:[button(type)]}});
const marketing = (...deliveries) => ({code:0,data:{server_time:1000,language:'en-US',deliveries}});

test('separate catalogue, settings and compact bridge processes share one access read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'm513-process-'));
  const child = () => new Promise((res, rej) => {
    const c = spawn(process.execPath, [resolve('tests/provider/discovery-worker.mjs'), root], { env: process.env });
    let out = '', err = ''; c.stdout.on('data', b => out += b); c.stderr.on('data', b => err += b);
    c.on('error', rej); c.on('close', code => code ? rej(Error(err)) : res(JSON.parse(out)));
  });
  try {
    assert.deepEqual(await Promise.all([child(), child(), child()]), Array(3).fill({ absent: true }));
    await child(); assert.equal(readFileSync(root + '/requests', 'utf8').trim(), 'GET balance');
  } finally { rmSync(root, { recursive: true }); }
});

test('access errors stay unknown and share an attempt gate; scope/version changes cannot reuse state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'm513-error-')); let calls = 0;
  const decode = v => v;
  try {
    const fail = () => readDiscovery(root, 'balance', 'account/version1', 60_000, async () => { calls++; throw Error('PRIVATE'); }, decode);
    await assert.rejects(fail(), /PRIVATE/); await assert.rejects(fail(), /discovery unavailable/); assert.equal(calls, 1);
    assert.equal(peekDiscovery(root, 'balance', 'account/version1', decode), undefined);
    assert.ok(!readFileSync(root + '/discovery-balance.json', 'utf8').includes('PRIVATE'));
    assert.deepEqual(await readDiscovery(root, 'balance', 'account/version2', 60_000, async () => { calls++; return { absent: true }; }, decode), { absent: true });
    assert.equal(calls, 2); assert.equal(peekDiscovery(root, 'balance', 'account/version1', decode), undefined);
    let current = true, release;
    const stale = readDiscovery(root, 'preview', 'old-scope', 60_000, () => new Promise(r => { release = r; }), decode, () => Infinity, () => current);
    current = false; release({ advertised: true }); await assert.rejects(stale, /scope changed/);
    assert.equal(existsSync(root + '/discovery-preview.json'), false, 'invalidated pending load must publish neither success nor failure');
  } finally { rmSync(root, { recursive: true }); }
});

test('synthetic absent → claim delivery → externally granted Start; no offer authorizes a model or notice fetch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'm513-transition-')), builtin = join(root, 'builtin.json'), credentials = join(root, 'credentials.json'), data = join(root, 'runtime');
  writeFileSync(builtin, '{"models":["GLM-5.3","GLM-5.3-Flash"]}'); writeFileSync(credentials, JSON.stringify({ zcodejwttoken: 'FAKE_JWT',
    'account-provider:account:zai-individual-coding-plan:identity': 'fixture', 'account-provider:account:zai-individual-coding-plan:auth-source': 'manual',
    'account-provider:coding-plan:account:zai-individual-coding-plan:account:fixture:api-key': 'FAKE_KEY' }));
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  telemetry(root);
  let granted = false, pending = false, advertised = false, gets = 0, queries = 0;
  // Public selected-action projection of M5.15's one real pre-claim response.
  const capturedOffer = JSON.parse(readFileSync(resolve('tests/provider/fixtures/m515-selected-offer.json'), 'utf8'));
  const dependencies = { personalHome: root, auth: new api.ReadOnlyAuth(credentials),
    paths: { executable: process.execPath, script: resolve('tests/provider/fake-v4.mjs'), builtin },
    discovery: () => ({ installed: true, supported: true, sha256: 'fixture', version: 'fixture' }), compatibility: () => ({ message: null }),
    startSnapshot: async () => { gets++; return startBalance({ code: 0, data: granted ? {
      server_time: Date.now() / 1000, plans: [{ plan_id: 'fixture', status: 'active', ends_at: Date.now() / 1000 + 3600 }],
      balances: [{ plan_id: 'fixture', period_start: Date.now() / 1000 + (pending ? 3600 : -3600), capabilities: ['model:GLM-5.3-Flash'], meter: 'model_usage', unit_type: 'token', total_units: 100, used_units: 0, remaining_units: 100, available_units: 100 }] } : {} }, ['GLM-5.3-Flash']); },
    startOffer: async () => { queries++; return advertised ? capturedOffer : {offers:[]}; },
    configure: async child => {
      const original = child.request.bind(child);
      child.request = async (method, params) => method === 'session/create' ? { settings: { model: {
        current: { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' },
        available: [['account:zai-individual-coding-plan', 'GLM-5.3'], ['account:zai-individual-coding-plan', 'GLM-5.3-Flash'], ['account:zai-start-plan', 'GLM-5.3-Flash']].map(([providerId, modelId]) => ({ ref: { providerId, modelId }, reasoning: { levels: [{ value: 'high' }], defaultLevel: 'high' } })) } } } : original(method, params);
    } };
  const runtime = api.createNativeServices(data, dependencies), other = api.createNativeServices(data, dependencies);
  const preference = enabled => writeFileSync(join(data,'account-selection.json'),JSON.stringify({checkStartPromotions:enabled}));
  try {
    assert.equal(runtime.services.startGuidance(), null); assert.equal(gets + queries, 0);
    assert.equal((await runtime.services.catalogue()).models.length, 2); assert.equal(runtime.services.startGuidance(), null);
    assert.equal(queries,0,'default-off catalogue still reads balance but never marketing');
    preference(true); await runtime.services.catalogue(); assert.equal(queries,1);
    clock += 59_000; await other.services.usage(); assert.equal(gets, 1);
    clock += 1_001; await other.services.usage(); assert.equal(gets, 2, 'a cold bridge must not restart snapshot age');
    advertised = true; clock += 10 * 60_000 + 1; await runtime.services.catalogue();
    const guidance = runtime.services.startGuidance(); assert.match(guidance, /review your eligibility/);
    assert.match(guidance, /update it if needed.*claim there.*refresh/);
    for (let n = 0; n < 4; n++) { assert.equal(runtime.services.startGuidance(), guidance); await runtime.services.usage(); await runtime.services.catalogue(); }
    assert.equal(gets, 3); assert.equal(queries, 2);
    preference(false); assert.equal(runtime.services.startGuidance(),null,'off suppresses already cached offer');
    clock += 600001; await runtime.services.catalogue(); await other.services.usage();
    assert.equal(queries,2,'off skips expired marketing cache as well');
    preference(true); await runtime.services.catalogue(); assert.equal(queries,3);
    await assert.rejects(runtime.services.validateSelection('GLM-5.3-Flash', 'high', 'desktop', 'start-plan'), /no entitled/);
    preference(false); granted = true; pending = true; clock += 60_001;
    assert.equal((await runtime.services.catalogue()).models.length, 2, 'pending quota must not add Start models');
    assert.match((await runtime.services.usage()).usage.planLabel, /pending/);
    preference(true); assert.equal(runtime.services.startGuidance(), null, 'pending grant suppresses the real cached Claim offer');
    clock += 600001; await runtime.services.catalogue();
    assert.equal(queries, 3, 'pending grant skips even an expired offer cache without a second marketing query');
    assert.equal(runtime.services.startGuidance(), null);
    await assert.rejects(runtime.services.validateSelection('GLM-5.3-Flash', 'high', 'desktop', 'start-plan'), /no entitled/);
    const getsBeforeGrant=gets;
    // Expire the access snapshot to emulate the next eligible user access.
    preference(false); pending = false; clock += 60_001;
    assert.equal((await runtime.services.catalogue()).models.length, 3); assert.equal(runtime.services.startGuidance(), null);
    assert.equal(gets, getsBeforeGrant+1); assert.equal(queries, 3);
    const snap = JSON.parse(readFileSync(join(data, 'discovery-balance.json'), 'utf8'));
    snap.value.entitlement.validUntil = Date.now() - 1; writeFileSync(join(data, 'discovery-balance.json'), JSON.stringify(snap));
    // A fresh bridge may not revive a locally expired grant or probe again.
    await assert.rejects(readDiscovery(data, 'balance', snap.scope, 60_000, async () => { throw Error('unexpected GET'); }, v => v, v => v.entitlement.validUntil), /snapshot expired/);
    assert.equal(gets, getsBeforeGrant+1);
    writeFileSync(credentials, '{"zcodejwttoken":"FAKE_ROTATED"}'); assert.equal(runtime.services.startGuidance(), null);
  } finally { await runtime.close(); await other.close(); rmSync(root, { recursive: true }); }
});

test('native selected delivery is a claim action; static ad, success popup and duplicate position cannot fabricate an offer', () => {
  assert.deepEqual(marketingStartOffer({...marketing(),data:{...marketing().data,configs:{startPlanPreview:{planId:'ad'}}}}),{offers:[]});
  assert.deepEqual(marketingStartOffer(marketing(delivery())), offer);
  assert.deepEqual(marketingStartOffer(marketing(delivery('banner','close'),delivery('banner'))),{offers:[]});
  const success=delivery('banner','close'); success.banner.success_popup=delivery('popup').popup;
  assert.deepEqual(marketingStartOffer(marketing(success)),{offers:[]});
  const bad=delivery(); delete bad.banner.background;
  assert.deepEqual(marketingStartOffer(marketing(bad,delivery())),offer);
  assert.equal(marketingStartOffer(marketing(delivery(),delivery('popup'))).offers.length,2);
  for(const v of [{code:401,data:marketing().data},{code:0,data:{}},{...marketing(),data:{...marketing().data,deliveries:Array(33).fill(delivery())}}])assert.throws(()=>marketingStartOffer(v));
});

test('claim offer HTTP uses native origin, fresh JWT/device/version, fixed English and GET only; failures never mean absent offer', async t => {
  const https=await import('node:https'), {EventEmitter}=await import('node:events'), {syncBuiltinESMExports}=await import('node:module');
  const original=https.default.request,root=mkdtempSync(join(tmpdir(),'m513-marketing-'));telemetry(root);
  const auth=new api.ReadOnlyAuth(join(root,'jwt')).fork('desktop',undefined,'start-plan');writeFileSync(auth.path,'{"zcodejwttoken":"FAKE_FIRST"}');
  let value=marketing(delivery()),status=200,count=0,rotateInFlight=false;
  t.mock.method(Intl,'DateTimeFormat',()=>({resolvedOptions:()=>({locale:'zh-CN'})}));
  https.default.request=(url,options,callback)=>{
    count++;assert.equal(url.origin,'https://fixture.invalid');assert.equal(url.pathname,'/api/v1/marketing/touch');assert.equal(options.method,'GET');
    assert.ok(/^\d+$/.test(url.searchParams.get('seq')));assert.equal(options.headers['X-Device-Mid'],device);assert.equal(options.headers['X-ZCode-App-Version'],'3.17.2');
    assert.equal(options.headers['X-Client-Language'],'en-US');assert.equal(options.headers.Authorization,count===1?'Bearer FAKE_FIRST':'Bearer FAKE_ROTATED');
    const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{const r=new EventEmitter();r.statusCode=status;r.headers={};callback(r);r.emit('data',Buffer.from(JSON.stringify(value)));if(rotateInFlight)writeFileSync(auth.path,'{"zcodejwttoken":"FAKE_DURING_REQUEST"}');r.emit('end');req.emit('close');});return req;
  };syncBuiltinESMExports();
  const env={ZCODE_BASE_URL:'https://fixture.invalid/path'};
  try{
    assert.deepEqual(await fetchStartOffer(auth,'3.17.2',env,root),offer);
    writeFileSync(auth.path,'{"zcodejwttoken":"FAKE_ROTATED"}');
    for(const code of [401,503]){status=code;await assert.rejects(fetchStartOffer(auth,'3.17.2',env,root),/claim discovery unavailable/);}
    status=200;value=marketing();assert.deepEqual(await fetchStartOffer(auth,'3.17.2',env,root),{offers:[]});assert.equal(count,4);
    assert.notDeepEqual(startOfferContext('3.17.2',env,root),startOfferContext('3.18.0',env,root));
    assert.equal(startOfferContext('3.17.2',{ZCODE_ENV:'test'},root).origin,'https://zcode.chatglm.site');
    assert.equal(startOfferContext('3.17.2',{ZCODE_ENDPOINT_ORIGIN:'https://other.invalid'},root).origin,'https://other.invalid');
    assert.ok(!JSON.stringify(startOfferContext('3.17.2',env,root)).includes('FAKE_'));
    rotateInFlight=true; await assert.rejects(fetchStartOffer(auth,'3.17.2',env,root),/claim discovery unavailable/);
  }finally{https.default.request=original;syncBuiltinESMExports();rmSync(root,{recursive:true});}
});

test('plugin promotion preference defaults off, projects changes and refreshes catalogue fingerprint without changing balance auth', async () => {
  const root=mkdtempSync(join(tmpdir(),'m513-preference-'));
  const {bb,harness}=createFakePluginHost({pluginId:'own',dataDir:root});
  try {
    await plugin(bb);
    const file=join(root,'plugins/own/bridge-data/zcode/account-selection.json');
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{authMode:'desktop',checkStartPromotions:false});
    await harness.behavior.setSettings({checkStartPromotions:true});
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{authMode:'desktop',checkStartPromotions:true});
    await harness.behavior.setSettings({checkStartPromotions:false});
    assert.equal(JSON.parse(readFileSync(file,'utf8')).checkStartPromotions,false);
  } finally { harness.dispose();rmSync(root,{recursive:true}); }
});

test('claim-action cache is shared, expires and clears offers; errors stay unknown for native maximum backoff', async t => {
  const root=mkdtempSync(join(tmpdir(),'m513-offer-cache-'));let clock=Date.now(),calls=0; t.mock.method(Date,'now',()=>clock);
  let state=offer;const read=()=>readDiscovery(root,'claim-offer','scope',600000,async()=>{calls++;if(state===null)throw Error('REMOTE');return state;},v=>v,()=>Infinity,()=>true,600000);
  try{
    await Promise.all([read(),read()]);assert.equal(calls,1);clock+=599999;await read();assert.equal(calls,1);
    clock+=2;assert.equal(peekDiscovery(root,'claim-offer','scope',v=>v),undefined);state={offers:[]};assert.deepEqual(await read(),state);assert.equal(calls,2);
    clock+=600001;state=null;await assert.rejects(read());clock+=120000;await assert.rejects(read(),/unavailable/);assert.equal(calls,3);
    assert.equal(peekDiscovery(root,'claim-offer','scope',v=>v),undefined);
  }finally{rmSync(root,{recursive:true});}
});

test('new-thread native warning uses cached qualified guidance; explicit key does not display it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'm513-notice-')), file = join(root, 'sessions.json'), out = []; let notices = 0;
  const bridge = api.createZCodeBridge({ prepare: async (_cwd, execution) => ({ launch: { executable: process.execPath, args: [resolve('tests/provider/fake-v4.mjs'), 'v4', file], cwd: root, env: api.childEnvironment(process.env, {}) },
    auth: new api.ReadOnlyAuth(join(root, 'missing')).fork(execution.authMode, undefined, execution.accountPlan), configure: async () => {} }),
    startGuidance: () => { notices++; return startClaimGuidance(offer); }, health: async () => ({}), installation: async () => ({}), models: async () => ({}), validateSelection: async () => {} }, m => out.push(m));
  let id = 0;
  const rpc = async (method, params) => { const n = ++id; bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: n, method, params })); for (let i = 0; i < 500; i++) { const r = out.find(m => m.id === n); if (r) { assert.equal(r.error, undefined, JSON.stringify(r)); return r.result; } await new Promise(r => setTimeout(r, 5)); } throw Error('timeout'); };
  const options = { model: 'GLM-5.3-Flash', reasoningLevel: 'high', permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null, providerOptions: {} };
  try {
    await rpc('thread/start', { threadId: 'own-notice', cwd: root, instructionMode: 'append', options });
    assert.equal(notices, 1);
    const warnings = out.flatMap(m => m.params?.deltas ?? []).filter(d => d.kind === 'provider.warning');
    assert.equal(warnings.length, 1); assert.match(warnings[0].summary, /does not confirm granted quota/);
    await rpc('thread/start', { threadId: 'own-key', cwd: root, instructionMode: 'append', options: { ...options, providerOptions: { authMode: 'coding-plan-key' } } });
    assert.equal(notices, 1);
    assert.equal(out.some(m => m.method === 'turn/started'), false);
  } finally { await bridge.close(); rmSync(root, { recursive: true }); }
});
