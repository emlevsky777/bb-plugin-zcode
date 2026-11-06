import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { api, plugin } from './helpers.mjs';
import { startEntitlement } from '../../src/start-plan.ts';
const plan = 'start-plan', providerId = 'account:zai-start-plan';
const input = { providerId, accountAccess: { type: 'zhipu-account', accountType: 'zai', mode: plan, entitled: true },
 modelSelection: { providerId, modelId: 'GLM-5.3-Flash' }, sessionId: 'own', reason: 'model-request', requestId: 'req', workspace: { workspacePath: '/own', workspaceKey: '/own' } };
const options = p => ({ permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null, providerOptions: p });
const balance = (end = 2000, status = 'active') => ({ code: 0, data: { server_time: 1000, plans: [{ user_plan_id: 'fake-plan', plan_id: 'fake', status, ends_at: end }], balances: [{ user_plan_id: 'fake-plan', plan_id: 'fake', capabilities: ['model:glm-5.3-flash', 'MODEL:GLM-5.3-FLASH'] }] } });
test('Start fresh shared JWT, no identity/project exchange, plan/source/account/model binding', async () => {
 const root = mkdtempSync(join(tmpdir(), 'm510-auth-')), path = join(root, 'credentials.json');
 try {
  writeFileSync(path, JSON.stringify({ zcodejwttoken: 'FAKE_JWT_1' }));
  const auth = new api.ReadOnlyAuth(path).fork('desktop', undefined, plan); let exchanges = 0;
  auth.setTokenRequest(async () => { exchanges++; throw Error('must not exchange'); });
  const before = readFileSync(path);
  assert.deepEqual((await auth.runtimeHeaders(input, 'own', '/own', 'GLM-5.3-Flash')).requestAuth, { apiKey: 'FAKE_JWT_1' });
  assert.deepEqual(readFileSync(path), before);
  writeFileSync(path, JSON.stringify({ zcodejwttoken: 'FAKE_JWT_2' }));
  assert.equal((await auth.runtimeHeaders(input, 'own', '/own', 'GLM-5.3-Flash')).requestAuth.apiKey, 'FAKE_JWT_2');
  for (const p of [{ ...input, providerId: api.accountProviderId }, { ...input, accountAccess: { ...input.accountAccess, mode: 'individual-coding-plan' } }, { ...input, modelSelection: { ...input.modelSelection, modelId: 'GLM-5.2' } }])
   await assert.rejects(auth.runtimeHeaders(p, 'own', '/own', 'GLM-5.3-Flash'));
  writeFileSync(path, '{}'); assert.throws(() => auth.read(), e => e.kind === 'unauthenticated'); assert.equal(exchanges, 0);
  assert.throws(() => api.executionOptions({ ...options({ authMode: 'coding-plan-key' }), model: 'start-plan/GLM-5.3-Flash' }), /Start Plan requires Desktop/);
  assert.equal(api.executionOptions(options({})).accountPlan, 'coding-plan');
  assert.equal(api.executionOptions({ ...options({}), model: 'start-plan/GLM-5.3-Flash' }).accountPlan, plan);
  assert.throws(() => api.executionOptions(options({ accountPlan: 'team' })));
 } finally { rmSync(root, { recursive: true }); }
});
test('native expiry, association, capabilities, date precedence, scheduled and unknown boundaries (synthetic)', () => {
 const ids = ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo'];
 assert.deepEqual(startEntitlement(balance(), ids, 1000000), { modelIds: ['GLM-5.3-Flash'], validUntil: 2000000 });
 for (const b of [balance(999), balance(2000, 'expired'), { code: 0, data: {} }, { code: 401 }, { code: 403 }, { code: 500 }]) assert.throws(() => startEntitlement(b, ids, 1000000));
 assert.throws(() => startEntitlement(balance(), ids, 1000000, 2000000));
 const b = balance(); b.data.plans.push({ user_plan_id: 'future', plan_id: 'future', status: 'scheduled', effective_at: 1100 });
 assert.equal(startEntitlement(b, ids, 1000000).validUntil, 1100000);
 const unknown = balance(); delete unknown.data.plans[0].ends_at;
 assert.equal(startEntitlement(unknown, ids, 1000000).validUntil, 1000000);
 const other = balance(999); other.data.balances[0].user_plan_id = 'unassociated';
 assert.deepEqual(startEntitlement(other, ids, 1000000).modelIds, ['GLM-5.3-Flash']); // native unmatched balance rule
});
test('Start catalogue shared fetch, warm zero requests, explicit/scope/time invalidation, failure attempt gate, persisted scope and plan separation', async t => {
 let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
 const root = mkdtempSync(join(tmpdir(), 'm510-cache-')), builtin = join(root, 'builtin.json'), credentials = join(root, 'credentials.json');
 writeFileSync(builtin, '{"models":["GLM-5.3-Flash"]}'); writeFileSync(credentials, '{"zcodejwttoken":"FAKE_JWT"}');
 const auth = new api.ReadOnlyAuth(credentials); let fetches = 0, fail = false, expired = false;
 const make = () => api.createNativeServices(join(root, 'runtime'), { auth, catalogueCache: true,
  paths: { executable: process.execPath, script: resolve('tests/provider/fake-v4.mjs'), builtin },
  discovery: () => ({ installed: true, supported: true, sha256: 'fake', version: 'fake' }),
  startBalance: async fresh => { fetches++; assert.equal(fresh.accountPlan(), plan); fresh.read('fake-balance'); await new Promise(r => setTimeout(r, 10)); if (fail) throw Error('Start Plan balance unavailable'); return { modelIds: ['GLM-5.3-Flash'], validUntil: Date.now() + (expired ? 20 : 60000) }; },
  configure: async child => { await child.request('runtime/capabilities', {}); const request = child.request.bind(child); child.request = async (method, p) => method === 'session/create'
   ? { settings: { model: { available: [{ ref: { providerId, modelId: 'GLM-5.3-Flash' }, reasoning: { levels: ['low', 'high', 'max'].map(value => ({ value })), defaultLevel: 'max' } }], current: { providerId, modelId: 'GLM-5.3-Flash' } } } } : request(method, p); }
 });
 let runtime = make(); const models = () => runtime.services.models(undefined, 'desktop', plan);
 try {
  const [a, b] = await Promise.all([models(), models()]); assert.deepEqual(a, b); assert.equal(fetches, 1);
  assert.equal(a.models[0].isDefault, true); assert.equal(a.models[0].defaultReasoningEffort, 'max');
  for (let i = 0; i < 3; i++) await runtime.services.validateSelection('GLM-5.3-Flash', 'high', 'desktop', plan);
  assert.equal(fetches, 1); await assert.rejects(runtime.services.validateSelection('GLM-5.2', 'max', 'desktop', plan)); assert.equal(fetches, 1);
  await runtime.close(); runtime = make(); await models(); assert.equal(fetches, 1, 'cold bridge shares public balance and native catalogue');
  runtime.services.invalidateCatalogue(); await Promise.all([models(), models()]); assert.equal(fetches, 2);
  writeFileSync(credentials, '{"zcodejwttoken":"FAKE_ROTATED"}'); await models(); assert.equal(fetches, 3);
  writeFileSync(builtin, '{"models":["GLM-5.3-Flash"],"revision":2}'); await models(); assert.equal(fetches, 4);
  runtime.services.invalidateCatalogue(); fail = true; await assert.rejects(models(), /unavailable/); assert.equal(fetches, 5);
  fail = false; expired = true; await assert.rejects(models(), /discovery unavailable/); assert.equal(fetches, 5); runtime.services.invalidateCatalogue(); await models(); assert.equal(fetches, 6);
  clock += 30; expired = false; await assert.rejects(models(), /snapshot expired/); assert.equal(fetches, 6); runtime.services.invalidateCatalogue(); await models(); assert.equal(fetches, 7);
  await assert.rejects(runtime.services.models(undefined, 'coding-plan-key', plan), /Start Plan requires Desktop/); assert.equal(fetches, 7);
  // Coding Plan cannot consume a Start credential-only store or its cache.
  await assert.rejects(runtime.services.models(undefined, 'desktop', 'coding-plan')); assert.equal(fetches, 7);
 } finally { await runtime.close(); rmSync(root, { recursive: true }); }
});
test('maintenance retains only explicit auth source; model/list consumes source env and health own source projection', async () => {
 const root = mkdtempSync(join(tmpdir(), 'm510-settings-')); let values = { authMode: 'desktop', backupKey: 'FAKE_SECRET' }, changed, contribution;
 try {
  await plugin({ pluginId: 'own', server: { experimental_dataDir: root },
   settings: { define: () => ({ get: async () => values, onChange: callback => { changed = callback; } }) },
   providers: { register() {}, experimental_contributeEnv: (id, callback) => { assert.equal(id, 'zcode-provider'); contribution = callback; } } });
  const projected = join(root, 'plugins/own/bridge-data/zcode/account-selection.json');
  assert.deepEqual(JSON.parse(readFileSync(projected,'utf8')), { authMode: 'desktop', checkStartPromotions: false });
  values = { ...values, authMode: 'coding-plan-key' }; changed(values);
  assert.deepEqual(JSON.parse(readFileSync(projected,'utf8')), { authMode: 'coding-plan-key', checkStartPromotions: false });
  const env = await contribution({}); assert.equal(env.length,2); assert.equal(env[0].value, 'coding-plan-key'); assert.equal(env[1].value,'false'); assert.ok(!JSON.stringify(env).includes(values.backupKey));
  const requests = [], out = [], bridge = api.createZCodeBridge({ prepare: async () => {}, health: async (...args) => { requests.push(args); return {}; }, installation: async () => ({}), models: async (...args) => { requests.push(args); return { models: [] }; }, validateSelection: async () => {} }, m => out.push(m));
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'model/list', params: { envVars: Object.fromEntries(env.map(e => [e.name,e.value])) } }));
  await new Promise(r=>setTimeout(r,10)); assert.deepEqual(requests[0], [undefined,'coding-plan-key']);
  bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'provider/health', params: {} }));
  await new Promise(r=>setTimeout(r,10)); assert.deepEqual(requests[1], [undefined]); await bridge.close();
  values = {...values,authMode:'desktop'}; changed(values);
  const auth = new api.ReadOnlyAuth(join(root,'jwt')); writeFileSync(auth.path,'{"zcodejwttoken":"FAKE"}');
  const runtime = api.createNativeServices(join(root,'plugins/own/bridge-data/zcode'), { auth, discovery:()=>({installed:true,supported:true,sha256:'fake',version:'fake'}), compatibility:()=>({message:null}) });
  assert.equal((await runtime.services.health()).health.planLabel,'Desktop Start Plan');
  values = {...values,authMode:'coding-plan-key'}; changed(values);
  const health = await runtime.services.health(); assert.equal(health.health.status,'unauthenticated'); assert.match(health.health.statusMessage,/Explicit Coding Plan key unavailable/);
  await runtime.close();
 } finally { rmSync(root,{recursive:true}); }
});
test('ordinary selected plan changes in same native session; active steer retains Start despite pending Coding Plan', async () => {
 const root=mkdtempSync(join(tmpdir(),'m510-selection-')), file=join(root,'sessions.json'), out=[];
 const bridge=api.createZCodeBridge({ prepare: async (_cwd,execution)=>({launch:{executable:process.execPath,args:[resolve('tests/provider/fake-v4.mjs'),'v4',file],cwd:root,env:api.childEnvironment(process.env,{})}, auth:new api.ReadOnlyAuth(join(root,'missing')).fork(execution.authMode,undefined,execution.accountPlan),configure:async()=>{}}),
 health:async()=>({}),installation:async()=>({}),models:async()=>({}),validateSelection:async()=>{} },m=>out.push(m));
 let ordinal=0;
 const rpc=async(method,params)=>{const id=++ordinal;bridge.handleLine(JSON.stringify({jsonrpc:'2.0',id,method,params}));for(let i=0;i<500;i++){const r=out.find(m=>m.id===id);if(r){assert.equal(r.error,undefined,JSON.stringify(r));return r.result;}await new Promise(r=>setTimeout(r,5));}throw Error('timeout');};
 const start={...options({}),model:'start-plan/GLM-5.3-Flash',reasoningLevel:'high'}, coding={...start,model:'GLM-5.3-Flash'};
 try{
  const {providerThreadId}=await rpc('thread/start',{threadId:'plan-own',cwd:root,instructionMode:'append',options:coding});
  const state=()=>JSON.parse(readFileSync(file,'utf8'))[providerThreadId];
  const turn={threadId:'plan-own',providerThreadId,clientRequestId:'creq_2222222222',options:start,input:[{type:'text',text:'/wait-for-interrupt'}]};
  await rpc('turn/start',turn);await new Promise(r=>setTimeout(r,50));assert.equal(state().config.modelSelection.providerId,providerId);
  const expectedTurnId=state().rows.window.find(r=>r.kind==='turnHeader').turnId;
  await rpc('turn/steer',{...turn,options:coding,expectedTurnId,clientRequestId:'creq_3333333333',input:[{type:'text',text:'guide'}]});
  assert.equal(state().steerCommands.at(-1).payload.modelSelection.providerId,providerId);
  await new Promise(r=>setTimeout(r,180));await rpc('turn/start',{...turn,options:coding,clientRequestId:'creq_4444444444',input:[{type:'text',text:'ordinary'}]});
  assert.equal(state().config.modelSelection.providerId,api.accountProviderId);assert.equal(Object.keys(JSON.parse(readFileSync(file,'utf8'))).length,1);
 }finally{await bridge.close();rmSync(root,{recursive:true});}
});
test('balance HTTP 401/403/transient failures do not retry or expose response; normal source headers and fresh JWT on independent needs', async () => {
 const https = await import('node:https'), { EventEmitter } = await import('node:events'), { syncBuiltinESMExports } = await import('node:module');
 const { fetchStartEntitlement } = await import('../../src/start-plan.ts');
 const original = https.default.request, root = mkdtempSync(join(tmpdir(),'m510-http-')); let status = 200, count = 0;
 const directory=join(root,'.zcode/v2');mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'telemetry-state.json'),'{"deviceMid":"FAKE_EXISTING_DEVICE"}');
 const auth=new api.ReadOnlyAuth(join(root,'jwt')).fork('desktop',undefined,plan);writeFileSync(auth.path,'{"zcodejwttoken":"FAKE_FIRST"}');
 https.default.request = (url, options, callback) => {
  count++; assert.equal(url.origin,'https://zcode.z.ai');assert.equal(url.searchParams.get('app_version'),'3.17.2');assert.equal(options.method,'GET');
  assert.equal(options.headers['X-Device-Mid'],'FAKE_EXISTING_DEVICE');assert.equal(options.headers['X-ZCode-App-Version'],'3.17.2');
  assert.equal(options.headers.Authorization,count===1?'Bearer FAKE_FIRST':'Bearer FAKE_ROTATED');
  const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=status;response.headers={date:new Date(1000000).toUTCString()};callback(response);response.emit('data',Buffer.from(status===200?JSON.stringify(balance()):'{"secret":"REMOTE_BODY_MUST_NOT_LEAK"}'));response.emit('end');req.emit('close');});return req;
 };syncBuiltinESMExports();
 try{
  assert.deepEqual((await fetchStartEntitlement(auth,'3.17.2',['GLM-5.3-Flash'],{},root)).modelIds,['GLM-5.3-Flash']);assert.equal(count,1);
  writeFileSync(auth.path,'{"zcodejwttoken":"FAKE_ROTATED"}');
  for(const code of [401,403,503]){status=code;const before=count;await assert.rejects(fetchStartEntitlement(auth,'3.17.2',['GLM-5.3-Flash'],{},root),e=>e.message==='Start Plan balance unavailable or sign-in rejected; check Desktop sign-in and retry an independent operation.');assert.equal(count,before+1);}
  status=200;await fetchStartEntitlement(auth,'3.17.2',['GLM-5.3-Flash'],{},root);assert.equal(count,5);
 }finally{https.default.request=original;syncBuiltinESMExports();rmSync(root,{recursive:true});}
});
test('native auth/grant rejection invalidates entitlement; model 5xx and native busy keep diagnosis without balance polling', async () => {
 const { invalidatesEntitlement } = await import('../../src/service-errors.ts');
 for(const value of [{code:'model_not_found'}, {code:'invalid_model_request',attribution:{providerErrorCode:'3006',statusCode:400,reason:'invalid_request'}}, {code:'invalid_model_request',attribution:{providerErrorCode:'3007',statusCode:401,reason:'auth_failed'}}, {code:'model_request_failed',attribution:{statusCode:403}}])assert.equal(invalidatesEntitlement(value),true);
 for(const value of [null, {}, {code:'model_request_failed',attribution:{statusCode:503,reason:'server_error'}}, ...['3008','3009','3010'].map(providerErrorCode=>({code:'model_rate_limited',attribution:{providerErrorCode,statusCode:429,reason:'rate_limited'}}))])assert.equal(invalidatesEntitlement(value),false);
});
