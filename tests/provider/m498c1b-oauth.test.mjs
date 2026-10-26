import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { api } from './helpers.mjs';
import { ProjectTokenResolver, ProjectTokenError } from '../../src/project-token.ts';

const params = { requestId: 'request', sessionId: 'session', reason: 'model-request', providerId: api.accountProviderId,
  workspace: { workspacePath: '/work', workspaceKey: '/work' }, modelSelection: { providerId: api.accountProviderId, modelId: 'GLM-5.3' },
  accountAccess: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai', entitled: true } };
function service(clock = () => Date.now()) {
  const calls = []; let token = 0, fail = false;
  const send = async (path, method, headers, body) => {
    calls.push({ path, method, headers, body });
    if (fail) throw new ProjectTokenError('project_token_request_failed', true);
    assert.notEqual(path, '/api/auth/z/login', 'Desktop token is already normalized');
    if (path.endsWith('getCustomerInfo')) return { code: 200, data: { organizations: [
      { organizationId: 'team-only', organizationName: '默认机构', projects: [{ projectId: 'team', projectType: 2 }] },
      { organizationId: 'other', projects: [{ projectId: 'other' }] },
      { organizationId: 'org', organizationName: '默认机构', projects: [
        { projectId: 'team', projectName: '默认项目', projectType: ' 2 ' },
        { projectId: 'project', projectName: '默认项目', projectType: 1 }] }] } };
    if (path.endsWith('/api_keys')) return { code: '200', data: [{ name: 'zcode-api-key', apiKey: 'key-id' }] };
    return { code: 0, data: { enable: true, accessToken: 'SYNTHETIC_PROJECT_' + ++token, tokenType: 'Bearer', expiresIn: 600, expiresAt: (clock() + 600000) / 1000 } };
  };
  return { calls, send, fail: () => { fail = true; } };
}
test('current Desktop OAuth and manual source selection; headers use a project token, fresh store scope, no writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c1b-oauth-')), file = join(dir, 'credentials.json');
  const store = { [`account-provider:${api.accountProviderId}:identity`]: 'SYNTHETIC_ACCOUNT',
    [`account-provider:${api.accountProviderId}:auth-source`]: 'oauth', 'oauth:zai:access_token': 'SYNTHETIC_OAUTH',
    [`account-provider:coding-plan:${api.accountProviderId}:account:SYNTHETIC_ACCOUNT:api-key`]: 'SYNTHETIC_MANUAL' };
  try {
    writeFileSync(file, JSON.stringify(store)); const bytes = readFileSync(file);
    const a = new api.ReadOnlyAuth(file), s = service();
    a.setNetworkEnvironment({}, '3.15.1'); a.setTokenRequest(s.send);
    assert.equal(a.read().oauth.accessToken, 'SYNTHETIC_OAUTH');
    assert.throws(() => a.headers(params, 'session', '/work', 'GLM-5.3'), /unsupported-mode/);
    const result = await a.runtimeHeaders(params, 'session', '/work', 'GLM-5.3');
    assert.equal(result.requestAuth.apiKey, 'SYNTHETIC_PROJECT_1');
    assert.equal(result.requestAuth.apiKeyId, 'key-id'); assert.match(result.requestAuth.accountScope, /^[a-f0-9]{64}$/);
    assert.equal(s.calls.length, 3);
    assert.ok(s.calls.every(c => c.headers.Authorization === 'Bearer SYNTHETIC_OAUTH'));
    assert.match(s.calls[1].path, /organization\/org\/projects\/project\/api_keys$/);
    assert.equal(s.calls[2].body.clientType, 'zcode');
    assert.equal(s.calls[2].body.clientVersion, '3.15.1');
    assert.equal(s.calls.filter(c => c.path.endsWith('/api_keys') && c.method === 'POST').length, 0);
    await a.runtimeHeaders(params, 'session', '/work', 'GLM-5.3'); assert.equal(s.calls.length, 3);
    assert.deepEqual(readFileSync(file), bytes);
    delete store['oauth:zai:access_token']; writeFileSync(file, JSON.stringify(store));
    assert.throws(() => a.read(), /unauthenticated/); // Never fall back to the saved manual key for OAuth.
    store['oauth:zai:access_token'] = 'SYNTHETIC_OAUTH';
    store[`account-provider:${api.accountProviderId}:auth-source`] = 'manual'; writeFileSync(file, JSON.stringify(store));
    assert.equal((await a.runtimeHeaders(params, 'session', '/work', 'GLM-5.3')).requestAuth.apiKey, 'SYNTHETIC_MANUAL');
    assert.equal(s.calls.length, 3);
    await assert.rejects(a.runtimeHeaders({ ...params, expectedAccountScope: result.requestAuth.accountScope }, 'session', '/work', 'GLM-5.3'), /scope_invalidated/);
    await assert.rejects(a.runtimeHeaders({ ...params, sessionId: 'wrong' }, 'session', '/work', 'GLM-5.3'));
  } finally { rmSync(dir, { recursive: true }); }
});
test('business 401 is sign-in required; other invalid responses stay distinct, without retry or private detail', async () => {
  for (const code of [401, '401', 500]) {
    let calls = 0;
    const resolver = new ProjectTokenResolver(async () => { calls++; return { code, data: null, msg: 'SYNTHETIC_PRIVATE_ERROR' }; });
    const expected = code === 500 ? 'project_token_invalid_response' : 'project_token_login_failed';
    await assert.rejects(resolver.resolve('account', 'oauth', {}, () => true), error => error.code === expected && !error.message.includes('PRIVATE'));
    assert.equal(calls, 1);
  }
});
test('HTTP 401 is a fixed non-transient sign-in error without a second HTTP request', () => {
  const code = `import https from 'node:https'; import {EventEmitter} from 'node:events'; import {syncBuiltinESMExports} from 'node:module';
    let calls=0; https.request=(url,options,callback)=>{calls++;const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=401;callback(res);res.emit('end');req.emit('close');});return req;};syncBuiltinESMExports();
    const {tokenRequest}=await import(${JSON.stringify(new URL('../../src/project-token.ts', import.meta.url).href)});
    try { await tokenRequest({})('/api/biz/customer/getCustomerInfo','GET',{});process.exitCode=1; }
    catch(e){if(e.code!=='project_token_login_failed'||e.transient||calls!==1)process.exitCode=2;}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
test('rejected stored sign-in reaches bridge authRequired with Desktop guidance; fresh sign-in works next time without writes', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'c1b-rejected-'))), file = join(dir, 'credentials.json');
  const store = { [`account-provider:${api.accountProviderId}:identity`]: 'SYNTHETIC_ACCOUNT',
    'oauth:zai:access_token': 'SYNTHETIC_EXPIRED' };
  writeFileSync(file, JSON.stringify(store)); const initial = readFileSync(file);
  const auth = new api.ReadOnlyAuth(file), out = [], observed = [], calls = []; let child;
  const s = service(); auth.setTokenRequest(async (...args) => {
    calls.push(args[0]);
    if (args[2].Authorization === 'Bearer SYNTHETIC_EXPIRED') return { code: 401, msg: 'SYNTHETIC_PRIVATE_ERROR' };
    return s.send(...args);
  });
  const bridge = api.createZCodeBridge({ prepare: async () => ({ auth,
    launch: { executable: process.execPath, args: [resolve('tests/provider/fake-v4.mjs'), 'v4'], cwd: dir, env: api.childEnvironment(process.env, {}) },
    configure: async p => { child = p; } }), models: async () => ({ models: [{ model: 'GLM-5.3' }] }),
    validateSelection: async () => {}, health: async () => ({}), installation: async () => ({}), observe: e => observed.push(e) }, e => out.push(e));
  try {
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'thread/start', params: { threadId: 'auth-expiry', cwd: dir, instructionMode: 'append',
      options: { model: 'GLM-5.3', reasoningLevel: 'high', permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null } } }));
    for (let i = 0; i < 500 && !out.some(e => e.id === 1); i++) await delay(5);
    assert.ok(out.find(e => e.id === 1)?.result, JSON.stringify(out));
    await child.request('auth-bad', {});
    for (let i = 0; i < 500 && !observed.some(e => e.event === 'runtime-headers-result'); i++) await delay(5);
    assert.equal(calls.length, 1); assert.deepEqual(readFileSync(file), initial);
    const recovery = out.filter(e => e.method === 'provider/recovery');
    assert.equal(recovery.length, 1); assert.equal(recovery[0].params.kind, 'authRequired');
    assert.equal(recovery[0].params.retryable, false); assert.match(recovery[0].params.message, /Open ZCode Desktop and sign in again/);
    assert.ok(out.some(e => e.params?.deltas?.some(d => d.category === 'unauthorized')));
    store['oauth:zai:access_token'] = 'SYNTHETIC_RENEWED'; writeFileSync(file, JSON.stringify(store)); const renewed = readFileSync(file);
    await child.request('auth-bad', {});
    for (let i = 0; i < 500 && !observed.some(e => e.event === 'runtime-headers-result' && e.headersApplied); i++) await delay(5);
    assert.ok(observed.some(e => e.event === 'runtime-headers-result' && e.headersApplied));
    assert.equal(calls.length, 4); assert.deepEqual(readFileSync(file), renewed);
    assert.equal(out.filter(e => e.method === 'provider/recovery').length, 1);
  } finally { await bridge.close(); rmSync(dir, { recursive: true }); }
});
test('rejected stored token and unknown network outcomes do not trigger login or blind retries', async () => {
  for (const error of [new ProjectTokenError('project_token_login_failed'), new ProjectTokenError('project_token_request_failed', true)]) {
    let calls = 0;
    const failed = new ProjectTokenResolver(async path => { calls++; assert.equal(path, '/api/biz/customer/getCustomerInfo'); throw error; });
    await assert.rejects(failed.resolve('account', 'oauth', {}, () => true), e => e === error);
    assert.equal(calls, 1);
  }
});
test('project token response retains current native strict expiry and enabled-state semantics', async () => {
  for (const delta of [{ enable: null }, { enable: 'true' }, { expiresAt: '2000000' }, { expiresIn: '600' }, { expiresIn: 0 }]) {
    const s = service();
    const r = new ProjectTokenResolver(async (...args) => {
      const value = await s.send(...args);
      return args[0].endsWith('/access_tokens') ? { ...value, data: { ...value.data, ...delta } } : value;
    });
    await assert.rejects(r.resolve('account', 'oauth', {}, () => true), /project_token_invalid_response/);
  }
});
test('native token expiry, rejected fingerprint, scope changes and transient refresh preserve native outcomes without model resends', async () => {
  let now = 1000000, valid = true; const s = service(() => now), r = new ProjectTokenResolver(s.send, () => now, () => 0);
  const first = await r.resolve('account', 'oauth', {}, () => valid);
  const fingerprint = createHash('sha256').update(first.apiKey).digest('hex');
  const next = await r.resolve('account', 'oauth', { expectedAccountScope: first.accountScope, rejectedProjectTokenFingerprint: fingerprint }, () => valid);
  assert.notEqual(next.apiKey, first.apiKey); assert.equal(s.calls.length, 6);
  await assert.rejects(r.resolve('account', 'oauth', { expectedAccountScope: 'wrong' }, () => valid), /scope_invalidated/);
  await assert.rejects(r.resolve('account', 'oauth', { rejectedProjectTokenFingerprint: fingerprint }, () => valid), /scope_invalidated/);
  now += 490000; s.fail(); assert.deepEqual(await r.resolve('account', 'oauth', {}, () => valid), next);
  now += 120000; await assert.rejects(r.resolve('account', 'oauth', {}, () => valid), /request_failed/);
  valid = false; await assert.rejects(r.resolve('account', 'oauth', {}, () => valid), /scope_invalidated/);
  let finish; const pendingResolver = new ProjectTokenResolver(() => new Promise(resolve => { finish = resolve; }));
  valid = true; const pending = pendingResolver.resolve('account', 'oauth', {}, () => valid);
  valid = false; finish({ code: 0, data: { accessToken: 'SYNTHETIC_LATE' } });
  await assert.rejects(pending, /scope_invalidated/);
});
