import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { createHash, createCipheriv } from 'node:crypto';
import { api } from './helpers.mjs';
import { ProjectTokenResolver, ProjectTokenError } from '../../src/project-token.ts';

const params = { requestId: 'request', sessionId: 'session', reason: 'model-request', providerId: api.accountProviderId,
  workspace: { workspacePath: '/work', workspaceKey: '/work' }, modelSelection: { providerId: api.accountProviderId, modelId: 'GLM-5.3' },
  accountAccess: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai', entitled: true } };
test('Desktop cipher overrides retain every byte, including whitespace-only secrets; store and config stay unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm499b-cipher-')), file = join(dir, 'credentials.json'), config = join(dir, 'config.json');
  try {
    writeFileSync(config, 'SYNTHETIC_CONFIG_SENTINEL');
    for (const secret of [' SYNTHETIC_OVERRIDE ', '   ']) {
      const key = createHash('sha256').update(secret).digest();
      const encrypt = value => {
        const iv = Buffer.alloc(12, 7), cipher = createCipheriv('aes-256-gcm', key, iv);
        const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return 'enc:v1:' + [iv, cipher.getAuthTag(), bytes].map(part => part.toString('base64url')).join('.');
      };
      writeFileSync(file, JSON.stringify({ [`account-provider:${api.accountProviderId}:identity`]: encrypt('SYNTHETIC_ACCOUNT'),
        'oauth:zai:access_token': encrypt('SYNTHETIC_OAUTH') }));
      const before = readFileSync(file);
      const auth = new api.ReadOnlyAuth(file, api.credentialCipherKey({ ZCODE_CREDENTIAL_SECRET: secret }));
      assert.equal(auth.read().oauth.accessToken, 'SYNTHETIC_OAUTH');
      assert.deepEqual(readFileSync(file), before);
      assert.equal(readFileSync(config, 'utf8'), 'SYNTHETIC_CONFIG_SENTINEL');
    }
  } finally { rmSync(dir, { recursive: true }); }
});
test('Desktop Bearer prefix normalization applies to transport and cache scope', async () => {
  const s = service(), resolver = new ProjectTokenResolver(s.send, undefined, undefined, '3.15.1');
  const first = await resolver.resolve('account', '  bEaReR SYNTHETIC_OAUTH  ', {}, () => true);
  assert.ok(s.calls.every(call => call.headers.Authorization === 'Bearer SYNTHETIC_OAUTH'));
  const second = await resolver.resolve('account', 'SYNTHETIC_OAUTH', { expectedAccountScope: first.accountScope }, () => true);
  assert.deepEqual(second, first); assert.equal(s.calls.length, 3);
});
test('valid customer JSON above 64 KiB follows native response handling without another request', () => {
  const code = `import https from 'node:https'; import {EventEmitter} from 'node:events'; import {syncBuiltinESMExports} from 'node:module';
    let calls=0; const body=JSON.stringify({code:200,data:{organizations:[{organizationId:'org',projects:[{projectId:'project'}]}],padding:'x'.repeat(70000)}});
    https.request=(url,options,callback)=>{calls++;const req=new EventEmitter();req.destroy=e=>queueMicrotask(()=>req.emit('error',e));
      req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;callback(res);res.emit('data',Buffer.from(body.slice(0,40000)));res.emit('data',Buffer.from(body.slice(40000)));res.emit('end');req.emit('close');});return req;};syncBuiltinESMExports();
    const {tokenRequest}=await import(${JSON.stringify(new URL('../../src/project-token.ts', import.meta.url).href)});
    const result=await tokenRequest({})('/api/biz/customer/getCustomerInfo','GET',{});
    if(calls!==1||result.data.organizations[0].projects[0].projectId!=='project'||result.data.padding.length!==70000)process.exitCode=1;`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
function service(clock = () => Date.now(), createKey = false) {
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
    if (path.endsWith('/api_keys')) return { code: '200', data: method === 'POST'
      ? { name: 'zcode-api-key', apiKey: 'key-id' }
      : createKey ? [] : [{ name: 'zcode-api-key', apiKey: 'key-id' }] };
    return { code: 0, data: { enable: true, accessToken: 'SYNTHETIC_PROJECT_' + ++token, tokenType: 'Bearer', expiresIn: 600, expiresAt: (clock() + 600000) / 1000 } };
  };
  return { calls, send, fail: () => { fail = true; } };
}
const headerFixtures = JSON.parse(readFileSync(new URL('./fixtures/m51-oauth-headers.json', import.meta.url), 'utf8'));
for (const expected of headerFixtures.sources) {
  test(`M51 native ${expected.desktop} headers per endpoint, normalization, optional key creation and cache`, async () => {
    for (const createKey of [false, true]) for (const oauth of ['SYNTHETIC_OAUTH', '  bEaReR SYNTHETIC_OAUTH  ']) {
      const s = service(undefined, createKey), resolver = new ProjectTokenResolver(s.send, undefined, undefined, expected.desktop);
      const first = await resolver.resolve('account', oauth, {}, () => true);
      assert.equal(s.calls[0].headers.Authorization, expected.customerInfo);
      assert.equal(s.calls[0].method, 'GET');
      const keyCalls = s.calls.filter(c => c.path.endsWith('/api_keys'));
      assert.deepEqual(keyCalls.map(c => c.method), createKey ? ['GET', 'POST'] : ['GET']);
      assert.ok(keyCalls.every(c => c.headers.Authorization === expected.apiKeys));
      if (createKey) assert.deepEqual(keyCalls[1].body, { name: 'zcode-api-key', usageScene: 1 });
      const issued = s.calls.at(-1);
      assert.match(issued.path, /\/key-id\/access_tokens$/); assert.equal(issued.method, 'POST');
      assert.equal(issued.headers.Authorization, expected.accessTokens);
      assert.deepEqual(issued.body, { clientType: 'zcode', clientVersion: expected.desktop });
      assert.equal(s.calls.length, createKey ? 4 : 3);
      const second = await resolver.resolve('account', 'SYNTHETIC_OAUTH', { expectedAccountScope: first.accountScope }, () => true);
      assert.deepEqual(second, first); assert.equal(s.calls.length, createKey ? 4 : 3);
    }
  });
}
test('M51 unobserved versions use latest observed customer format; exact legacy stable plus build metadata retains Bearer', async () => {
  for (const [version, customer] of [
    ['unknown', 'SYNTHETIC_OAUTH'], ['', 'SYNTHETIC_OAUTH'], ['invalid', 'SYNTHETIC_OAUTH'],
    ['3.15.0', 'SYNTHETIC_OAUTH'], ['3.15.2', 'SYNTHETIC_OAUTH'], ['3.16.2', 'SYNTHETIC_OAUTH'],
    ['3.15.1-rc.1', 'SYNTHETIC_OAUTH'], ['3.16.3-rc.1', 'SYNTHETIC_OAUTH'], ['4.0.0', 'SYNTHETIC_OAUTH'],
    ['3.15.1+build.7', 'Bearer SYNTHETIC_OAUTH'], ['3.16.3+build.7', 'SYNTHETIC_OAUTH']
  ]) {
    const s = service(), resolver = new ProjectTokenResolver(s.send, undefined, undefined, version);
    await resolver.resolve('account', 'SYNTHETIC_OAUTH', {}, () => true);
    assert.equal(s.calls[0].headers.Authorization, customer, version);
    assert.ok(s.calls.slice(1).every(c => c.headers.Authorization === 'Bearer SYNTHETIC_OAUTH'));
    assert.equal(s.calls.at(-1).body.clientVersion, version); assert.equal(s.calls.length, 3);
  }
});
for (const expected of headerFixtures.sources) test(`Desktop ${expected.desktop} OAuth and manual source selection; fresh store scope, no writes`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c1b-oauth-')), file = join(dir, 'credentials.json');
  const store = { [`account-provider:${api.accountProviderId}:identity`]: 'SYNTHETIC_ACCOUNT',
    [`account-provider:${api.accountProviderId}:auth-source`]: 'oauth', 'oauth:zai:access_token': 'SYNTHETIC_OAUTH',
    [`account-provider:coding-plan:${api.accountProviderId}:account:SYNTHETIC_ACCOUNT:api-key`]: 'SYNTHETIC_MANUAL' };
  try {
    writeFileSync(file, JSON.stringify(store)); const bytes = readFileSync(file);
    const a = new api.ReadOnlyAuth(file), s = service();
    a.setNetworkEnvironment({}, expected.desktop); a.setTokenRequest(s.send);
    assert.equal(a.read().oauth.accessToken, 'SYNTHETIC_OAUTH');
    assert.throws(() => a.headers(params, 'session', '/work', 'GLM-5.3'), /unsupported-mode/);
    const result = await a.runtimeHeaders(params, 'session', '/work', 'GLM-5.3');
    assert.equal(result.requestAuth.apiKey, 'SYNTHETIC_PROJECT_1');
    assert.equal(result.requestAuth.apiKeyId, 'key-id'); assert.match(result.requestAuth.accountScope, /^[a-f0-9]{64}$/);
    assert.equal(s.calls.length, 3);
    assert.equal(s.calls[0].headers.Authorization, expected.customerInfo);
    assert.ok(s.calls.slice(1).every(c => c.headers.Authorization === expected.apiKeys));
    assert.match(s.calls[1].path, /organization\/org\/projects\/project\/api_keys$/);
    assert.equal(s.calls[2].body.clientType, 'zcode');
    assert.equal(s.calls[2].body.clientVersion, expected.desktop);
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
  auth.setNetworkEnvironment({}, '3.15.1');
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
