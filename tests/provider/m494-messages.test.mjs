import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { api, artifact, plugin } from './helpers.mjs';

test('M494 cold, warm, missing and forced discovery; Spotlight skips enumeration', () => {
  const root = mkdtempSync(join(tmpdir(), 'm494-path-')), bundle = join(root, 'Moved.app');
  let mdfind = 0, plutil = 0, enumerate = 0;
  const paths = api.pathsForZCode(bundle), events = [];
  const options = { spotlight: () => { mdfind++; return [bundle]; }, bundleId: () => { plutil++; return 'dev.zcode.app'; },
    canonical: p => p, enumerate: () => { enumerate++; return []; } };
  const put = () => { for (const file of Object.values(paths)) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'fixture'); } };
  try {
    put(); api.createZCodeLocator(root, options, e => events.push(e))();
    assert.deepEqual([mdfind, plutil, enumerate], [1, 1, 0]);
    assert.equal(JSON.parse(readFileSync(join(root, 'application-path.json'))).bundle, bundle);
    mdfind = plutil = 0;
    const locate = api.createZCodeLocator(root, options, e => events.push(e)); locate();
    assert.deepEqual([mdfind, plutil, enumerate], [0, 0, 0]);
    unlinkSync(paths.script); locate(); assert.deepEqual([mdfind, plutil], [1, 1]);
    put(); locate(true); assert.deepEqual([mdfind, plutil], [2, 2]);
    assert.ok(events.some(e => e.event === 'zcode-path-cache-hit' && e.search === false));
  } finally { rmSync(root, { recursive: true }); }
});

test('M494 server import and registration do not invoke discovery commands', () => {
  const entry = resolve(artifact ? 'dist/plugin.js' : 'src/plugin.ts');
  const code = `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
    let calls=0; cp.execFileSync=()=>{calls++;throw Error('unexpected process');}; syncBuiltinESMExports();
    const {default:plugin}=await import(${JSON.stringify(entry)});
    await plugin({settings:{define:()=>({get:async()=>({authMode:'desktop'}),onChange(){}})},providers:{register(){}}});
    if(calls) throw Error('Server searched for ZCode');`;
  execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
});

test('M494 startup ENOENT refreshes path record without sending input again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'm494-missing-'));
  const oldBundle = join(root, 'Old.app'), newBundle = join(root, 'New.app');
  let selectedBundle = oldBundle, searches = 0;
  for (const bundle of [oldBundle, newBundle]) for (const file of Object.values(api.pathsForZCode(bundle))) {
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'fixture');
  }
  const locate = api.createZCodeLocator(root, { spotlight: () => { searches++; return [selectedBundle]; }, bundleId: () => 'dev.zcode.app', canonical: p => p });
  locate(); selectedBundle = newBundle;
  let refreshes = 0, deaths = [];
  const child = new api.NativeProcess({ executable: join(root, 'gone'), args: [], cwd: root, env: { PATH: process.env.PATH },
    onMissingFiles: () => { refreshes++; locate(true); } }, 1, null, () => {}, e => deaths.push(e));
  try {
    await assert.rejects(child.request('runtime/capabilities', {}), e => e instanceof api.MissingExecutableError);
    await child.close(); assert.equal(refreshes, 1); assert.ok(deaths[0] instanceof api.MissingExecutableError);
    assert.equal(searches, 2); assert.equal(JSON.parse(readFileSync(join(root, 'application-path.json'))).bundle, newBundle);
  } finally { await child.close(); rmSync(root, { recursive: true }); }
});

test('M494 all codes logged; routine diagnostics hidden; incompatibility once per thread across restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'm494-notices-')), logs = [], shown = [];
  const reporter = () => api.createDiagnosticReporter(e => logs.push(e), (thread, summary) => shown.push({ thread, summary }),
    (thread, code) => api.claimNotice(root, api.diagnosticNoticeName(thread, code), code));
  try {
    const first = reporter(), codes = ['generic-native-tool', 'execution-fields-unavailable', 'unknown-row-kind', 'unsupported-delta-operation', 'conflicting-terminal-sources'];
    for (let i = 0; i < 3; i++) for (const code of codes) first('t1', code);
    assert.equal(logs.length, 15); assert.equal(shown.length, 3);
    for (const code of codes) reporter()('t1', code);
    assert.equal(shown.length, 3); assert.equal(logs.length, 20);
    first('t2', 'unknown-row-kind'); assert.equal(shown.length, 4);
    assert.ok(shown.every(e => /contact.*maintainer.*code/.test(e.summary) && !/protocol diagnostic/.test(e.summary)));
  } finally { rmSync(root, { recursive: true }); }
});

test('M494 atomic notice marker suppresses repeated keys across restart and publishes complete concurrent records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'm494-claim-')), file = join(root, 'notice.json');
  const entry = resolve(artifact ? 'dist/messages.js' : 'src/messages.ts');
  const code = `const {claimNotice}=await import(${JSON.stringify(entry)}); console.log(claimNotice(process.argv[1], 'notice', process.argv[2]));`;
  const args = key => ['--input-type=module', '-e', code, root, key];
  const options = { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
  try {
    assert.equal(api.claimNotice(root, 'notice', 'A'), true);
    assert.equal(api.claimNotice(root, 'notice', 'A'), false);
    assert.equal(execFileSync(process.execPath, args('A'), options).trim(), 'false', 'new process reads the previous marker');
    assert.equal(execFileSync(process.execPath, args('B'), options).trim(), 'true', 'changed key is published');
    assert.equal(api.claimNotice(root, 'notice', 'B'), false);
    writeFileSync(file, '{'); assert.equal(api.claimNotice(root, 'notice', 'B'), true, 'invalid marker is recovered');
    const results = await Promise.all(Array.from({ length: 8 }, () => promisify(execFile)(process.execPath, args('C'), options)));
    const shown = results.filter(r => r.stdout.trim() === 'true').length;
    assert.ok(shown >= 1 && shown <= 8, 'concurrent duplicate is allowed by M4.9.6a');
    assert.ok(results.every(r => ['true', 'false'].includes(r.stdout.trim())));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { key: 'C' });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(root), ['notice.json'], 'no lock or temporary record remains');
    assert.equal(execFileSync(process.execPath, args('C'), options).trim(), 'false');
  } finally { rmSync(root, { recursive: true }); }
});

test('Version notices remain available to each new thread; health is concise without a CLI login action', async () => {
  const root = mkdtempSync(join(tmpdir(), 'm494-health-')), auth = new api.ReadOnlyAuth(join(root, 'auth.json'));
  const checked = { ...api.compatibilityReference };
  const checkedTable = [{ tuple: checked, level: 'level1', pluginRevision: 'fixture', resultRef: 'fixture', evidenceRef: 'fixture' }];
  let combination = { ...checked, bb: '9.1.0' }, installed = true;
  const paths = { executable: process.execPath, script: '/fixture/ZCode.app/Contents/Resources/glm/zcode.cjs', builtin: '/fixture/builtin' };
  const runtime = () => api.createNativeServices(root, { auth, paths,
    discovery: () => ({ installed, supported: true, sha256: null, version: '0.16.9' }), compatibility: () => api.compareCompatibility(combination, checkedTable) });
  const put = () => writeFileSync(auth.path, JSON.stringify({ [`account-provider:${api.accountProviderId}:auth-source`]: 'manual', [`account-provider:${api.accountProviderId}:identity`]: 'FIXTURE',
    [`account-provider:coding-plan:${api.accountProviderId}:account:FIXTURE:api-key`]: 'FIXTURE' }));
  try {
    let r = runtime(); assert.match(r.services.compatibilityWarning(), /9.1.0/); await r.close();
    r = runtime(); assert.match(r.services.compatibilityWarning(), /9.1.0/);
    combination = { ...combination, installedSdk: '0.6.300' }; assert.match(r.services.compatibilityWarning(), /9.1.0/);
    combination = { ...combination, bb: '9.2.0' }; assert.match(r.services.compatibilityWarning(), /9.2.0/);
    combination = checked; assert.equal(r.services.compatibilityWarning(), null);
    put(); const ready = (await r.services.health()).health;
    assert.equal(ready.statusMessage, 'Ready. ZCode: /fixture/ZCode.app.'); assert.equal(ready.loginCommand, null);
    r.services.observe({ event: 'catalogue-cache-recovery' });
    assert.equal((await r.services.health()).health.statusMessage, ready.statusMessage);
    combination = { ...combination, bb: '9.2.0' }; assert.match((await r.services.health()).health.statusMessage, /Ready.*maintainer has not yet verified/);
    unlinkSync(auth.path); assert.match((await r.services.health()).health.statusMessage, /Open ZCode Desktop and sign in again/);
    installed = false; assert.equal((await r.services.health()).health.status, 'not_installed');
    assert.doesNotMatch((await r.services.health()).health.statusMessage, /Open ZCode Desktop/); await r.close();
  } finally { rmSync(root, { recursive: true }); }
});

test('BB results produce one combined notice on new thread start, never on turns, resume or errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'zcode-plugin-update-'));
  const position = { permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null };
  const available = (id, version) => ({ id, outcome: 'update-available', candidate: { version } });
  const id = 'zcode-provider', a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
  const stored = new Map();
  let declaration, dispatch, requests = 0, hostSerial = 0;
  let updates = [available('another-plugin', a), { ...available(id, a), outcome: 'incompatible' }];
  const register = () => plugin({
    pluginId: id,
    settings: { define: () => ({ get: async () => ({}), onChange() {} }) },
    providers: { register: value => { declaration = value; } },
    background: { service: () => { throw Error('No idle service expected'); } },
    experimental_hooks: { on: (name, callback) => { assert.equal(name, 'message.dispatch'); dispatch = callback; } },
    storage: { kv: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, structuredClone(value)) } },
    sdk: {
      plugins: { listUpdateResults: async () => { requests++; if (updates instanceof Error) throw updates; return updates; } },
      subscribe: () => { throw Error('No reconnect or plugin-change subscriptions expected'); },
    },
  });
  await register();
  const currentOptions = () => ({ ...position, providerOptions: declaration.deriveProviderOptions({ settings: {} }) });
  const optionsFor = async entries => {
    updates = entries;
    // A new hourly interval, without changing the process-wide clock.
    for (const value of stored.values()) value.checkedAt = 0;
    await register();
    assert.deepEqual(await dispatch({ requestedExecution: { providerId: id }, thread: { status: 'pending' }, host: { id: `host-${++hostSerial}` } }), { action: 'proceed' });
    return currentOptions();
  };
  let serial = 0;
  const startThread = async (options, { turns = [], fail = false, compatibility = null, resume = false } = {}) => {
    const output = [];
    const runtime = api.createNativeServices(root, { compatibility: () => {
      if (compatibility instanceof Error) throw compatibility;
      return { message: compatibility };
    } });
    const createBridge = () => api.createZCodeBridge({
      ...runtime.services,
      prepare: async () => {
        if (fail) throw Error('Synthetic primary startup failure');
        return {
          launch: { executable: process.execPath, args: [resolve('tests/provider/fake-v4.mjs'), 'v4', join(root, `sessions-${serial}.json`)], cwd: root,
            env: api.childEnvironment(process.env, { HOME: root, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }) },
          auth: new api.ReadOnlyAuth(join(root, 'synthetic')),
          configure: async () => {},
        };
      },
      validateSelection: async () => {},
    }, message => output.push(message));
    let bridge = createBridge();
    let request = 0;
    const rpc = async (method, params) => {
      const id = ++request;
      bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      for (let i = 0; i < 400 && !output.some(message => message.id === id); i++) await delay(5);
      const response = output.find(message => message.id === id);
      assert.ok(response, method);
      return response;
    };
    try {
      const threadId = `update-test-${++serial}`;
      const response = await rpc('thread/start', { threadId, cwd: root, instructionMode: 'append', options });
      if (fail) {
        assert.equal(response.error?.code, -32000);
        return response.error.message;
      }
      assert.ok(response.result, JSON.stringify(response));
      const startWarnings = output.flatMap(message => message.params?.deltas ?? []).filter(delta => delta.kind === 'provider.warning');
      if (resume) {
        assert.ok((await rpc('thread/stop', { threadId, providerThreadId: response.result.providerThreadId, intent: 'release', activeTurnId: null })).result);
        const duplicate = await rpc('thread/start', { threadId, cwd: root, instructionMode: 'append', options });
        assert.match(duplicate.error?.message, /Created native identity requires recovery\/resume/);
        await bridge.close();
        bridge = createBridge();
        assert.ok((await rpc('thread/resume', { threadId, providerThreadId: response.result.providerThreadId,
          cwd: root, instructionMode: 'append', options })).result);
      }
      for (const turn of turns) {
        const boundaryCount = output.flatMap(message => message.params?.deltas ?? []).filter(delta => delta.kind === 'turn.boundary').length;
        const result = await rpc('turn/start', { threadId, providerThreadId: response.result.providerThreadId,
          clientRequestId: `creq_${String(request + 1).repeat(10)}`, input: [{ type: 'text', text: 'ping' }], options: turn });
        assert.equal(result.error, undefined, JSON.stringify(result));
        for (let i = 0; i < 400 && output.flatMap(message => message.params?.deltas ?? []).filter(delta => delta.kind === 'turn.boundary').length === boundaryCount; i++) await delay(5);
        assert.ok(output.flatMap(message => message.params?.deltas ?? []).filter(delta => delta.kind === 'turn.boundary').length > boundaryCount, 'input completed');
      }
      const warnings = output.flatMap(message => message.params?.deltas ?? []).filter(delta => delta.kind === 'provider.warning');
      assert.deepEqual(warnings, startWarnings, 'turns and resume must not add startup notices');
      if (startWarnings.length) {
        const noticeIndex = output.findIndex(message => message.params?.deltas?.includes(startWarnings[0]));
        assert.ok(noticeIndex < output.findIndex(message => message.id === 1), 'notice precedes thread/start reply and first input');
      }
      return warnings;
    } finally {
      await bridge.close();
      await runtime.close();
    }
  };
  try {
    await Promise.resolve();
    assert.equal(requests, 0, 'plugin load is idle');
    for (const status of ['idle', 'active', 'starting', 'error'])
      assert.deepEqual(await dispatch({ requestedExecution: { providerId: id }, thread: { status }, host: { id: 'host-existing' } }), { action: 'proceed' });
    await dispatch({ requestedExecution: { providerId: 'another-provider' }, thread: { status: 'pending' }, host: { id: 'host-existing' } });
    assert.equal(requests, 0, 'ordinary turns, resume and other providers do not read update results');
    await optionsFor(updates);
    const unavailable = currentOptions();
    assert.equal(unavailable.providerOptions.pluginUpdateCandidate, undefined);
    assert.equal(requests, 1);
    const marker = join(root, 'last-version-combination.json');
    mkdirSync(marker);
    assert.deepEqual(await startThread(unavailable), []);
    assert.equal((await startThread(unavailable, { compatibility: 'Synthetic compatibility notice.' })).length, 1);
    rmSync(marker, { recursive: true });
    const first = await optionsFor([available(id, a)]);
    assert.equal(first.providerOptions.pluginUpdateCandidate, a);
    const notices = await startThread(unavailable, { turns: [first, first] });
    assert.deepEqual(notices, []);
    const combined = await startThread(first, { compatibility: 'Synthetic compatibility notice.', turns: [first, first], resume: true });
    assert.equal(combined.length, 1);
    assert.match(combined[0].summary, /^Synthetic compatibility notice\. An update for ZCode Provider is available.*choose Update/);
    assert.equal((await startThread(first)).length, 1);
    const next = await optionsFor([available(id, b)]);
    assert.equal((await startThread(next)).length, 1);
    assert.equal((await startThread(next)).length, 1);
    assert.equal((await startThread(first)).length, 1);
    const failing = await optionsFor([available(id, c)]);
    const failure = { fail: true, compatibility: 'Synthetic compatibility notice.' };
    assert.equal(await startThread(failing, failure), 'Synthetic primary startup failure');
    assert.equal(await startThread(failing, failure), 'Synthetic primary startup failure');
    assert.equal((await startThread(failing, { compatibility: failure.compatibility })).length, 1);
    const current = await optionsFor([{ id, outcome: 'current' }]);
    assert.equal(current.providerOptions.pluginUpdateCandidate, undefined);
    assert.deepEqual(await startThread(current, { compatibility: new Error('Unavailable metadata'), turns: [first, current], resume: true }), []);
    assert.deepEqual(await startThread(current, { turns: [current, current], resume: true }), []);
    assert.equal(requests, 5);
    const failedRead = await optionsFor(new Error('BB results temporarily unavailable'));
    assert.equal(failedRead.providerOptions.pluginUpdateCandidate, undefined);
    assert.deepEqual(await startThread(failedRead, { turns: [failedRead] }), []);
    assert.equal(requests, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Update-result lookup is lazy and shared hourly across starts and reload; failures keep the last result', async () => {
  const stored = new Map();
  let now = 1000, requests = 0, fail = false, version = 'a'.repeat(40), release;
  const bb = { pluginId: 'own', storage: { kv: {
    get: async key => structuredClone(stored.get(key)),
    set: async (key, value) => { stored.set(key, structuredClone(value)); },
  } }, sdk: { plugins: { listUpdateResults: async () => {
    requests++;
    if (release) await new Promise(resolve => { release.resolve = resolve; });
    if (fail) throw Error('Synthetic unavailable results');
    return version ? [{ id: 'own', outcome: 'update-available', candidate: { version } }] : [{ id: 'own', outcome: 'current' }];
  } } } };
  let lookup = api.createPluginUpdateLookup(bb, () => now);
  assert.equal(requests, 0);
  release = {};
  const starts = Array.from({ length: 8 }, () => lookup());
  while (!release.resolve) await delay(1);
  assert.equal(requests, 1);
  release.resolve(); release = undefined;
  assert.deepEqual(await Promise.all(starts), Array(8).fill(version));
  now += 3_599_999;
  lookup = api.createPluginUpdateLookup(bb, () => now);
  assert.equal(await lookup(), version);
  assert.equal(requests, 1, 'reload and more starts reuse the persisted result');
  now++;
  fail = true;
  assert.equal(await lookup(), version);
  assert.equal(requests, 2, 'one failed attempt at expiry');
  lookup = api.createPluginUpdateLookup(bb, () => now);
  assert.equal(await lookup(), version);
  assert.equal(requests, 2, 'failed attempts also survive reload');
  assert.equal(await lookup(), version);
  assert.equal(requests, 2, 'all hosts share the installation result');
  fail = false; version = null; now += 3_600_000;
  assert.equal(await lookup(), null);
  assert.equal(requests, 3, 'successful current result clears the old candidate');
});

test('Same-copy reload reuses the result; same-version installation change clears its offer without an extra hourly read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notice-installation-'));
  try {
    const source = readFileSync(new URL(artifact ? '../../dist/plugin-update.js' : '../../src/plugin-update.ts', import.meta.url), 'utf8');
    const files = ['revision-a', 'revision-b'].map(dir => {
      mkdirSync(join(root, dir));
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ version: '0.2.4', type: 'module' }));
      const file = join(root, dir, artifact ? 'lookup.mjs' : 'lookup.mts');
      writeFileSync(file, source);
      return pathToFileURL(file).href;
    });
    // A fresh process exercises ESM reload identities without computed imports
    // in the shipped test module. Every fixture import is a literal URL.
    const code = `import assert from 'node:assert/strict';
    import {readFileSync,writeFileSync} from 'node:fs';
    const {pluginUpdateNotice}=await import(${JSON.stringify(pathToFileURL(resolve(artifact ? 'dist/messages.js' : 'src/messages.ts')).href)});
    const stored = new Map();
    let requests = 0, current = false;
    const bb = { pluginId: 'own', storage: { kv: {
      get: async key => structuredClone(stored.get(key)),
      set: async (key, value) => { stored.set(key, structuredClone(value)); },
    } }, sdk: { plugins: { listUpdateResults: async () => {
      requests++;
      return current ? [{ id: 'own', outcome: 'current' }] : [{ id: 'own', outcome: 'update-available', candidate: { version: 'a'.repeat(40) } }];
    } } } };
    const source=readFileSync(new URL(${JSON.stringify(files[1])}), 'utf8');
    const first = await import(${JSON.stringify(files[0] + '?load=1')});
    assert.match(await first.createPluginUpdateLookup(bb, () => 1000)(), /^a{40}$/);
    const same = await import(${JSON.stringify(files[0] + '?load=2')});
    assert.match(await same.createPluginUpdateLookup(bb, () => 1100)(), /^a{40}$/);
    assert.equal(requests, 1, 'cache-busting import query does not change installed identity');
    current = true;
    const updated = await import(${JSON.stringify(files[1])});
    const lookup = updated.createPluginUpdateLookup(bb, () => 1200);
    assert.equal(await lookup(), null);
    assert.equal(pluginUpdateNotice(await lookup()), null);
    assert.equal(requests, 1, 'new copy invalidates the offer, retaining the shared hour');
    const updatedReload = await import(${JSON.stringify(files[1] + '?load=2')});
    assert.equal(await updatedReload.createPluginUpdateLookup(bb, () => 1300)(), null, 'updated copy persists the invalidated offer');
    assert.equal(requests, 1);
    current = false;
    assert.match(await updatedReload.createPluginUpdateLookup(bb, () => 3_601_200)(), /^a{40}$/);
    assert.equal(requests, 2);
    writeFileSync(new URL(${JSON.stringify(files[1])}), source + '\\n// Synthetic rebuilt module at the same path.\\n');
    const rebuilt = await import(${JSON.stringify(files[1] + '?load=3')});
    assert.equal(await rebuilt.createPluginUpdateLookup(bb, () => 3_601_300)(), null);
    assert.equal(requests, 2, 'changed module bytes also invalidate the offer without an extra read');`;
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Interleaved host starts derive the same installation result, even when the BB result changes between hooks', async () => {
  const stored = new Map();
  let declaration, dispatch, requests = 0, updates = [{ id: 'own', outcome: 'current' }];
  await plugin({ pluginId: 'own',
    settings: { define: () => ({ get: async () => ({}), onChange() {} }) },
    providers: { register: value => { declaration = value; } },
    experimental_hooks: { on: (_name, callback) => { dispatch = callback; } },
    storage: { kv: { get: async key => stored.get(key), set: async (key, value) => stored.set(key, structuredClone(value)) } },
    sdk: { plugins: { listUpdateResults: async () => { requests++; return updates; } } },
  });
  const context = (host, threadId) => ({ requestedExecution: { providerId: 'zcode-provider' }, thread: { id: threadId, status: 'pending' }, host: { id: host } });
  await dispatch(context('host-b', 'thread-b'));
  updates = [{ id: 'own', outcome: 'update-available', candidate: { version: 'a'.repeat(40) } }];
  await dispatch(context('host-a', 'thread-a'));
  const optionsB = declaration.deriveProviderOptions({ threadId: 'thread-b', settings: {} });
  const optionsA = declaration.deriveProviderOptions({ threadId: 'thread-a', settings: {} });
  assert.equal(optionsB.pluginUpdateCandidate, undefined);
  assert.equal(optionsA.pluginUpdateCandidate, undefined);
  assert.equal(requests, 1, 'another host cannot replace the shared result inside its hour');
});

test('M494 native background command is preserved verbatim in an English recovery notice', () => {
  const root = mkdtempSync(join(tmpdir(), 'm494-background-')), file = join(root, 'tasks.json');
  try {
    writeFileSync(file, JSON.stringify({ version: 2, sessionId: 's', tasks: [{ workId: 'w', key: JSON.stringify(['s', 'background', 'w']), closed: false, description: 'bash --label \u0430\u0440\u0433\u0443\u043c\u0435\u043d\u0442' }] }));
    const tasks = new api.BackgroundTasks('s', () => {}, file), ds = tasks.baseline({ rows: { window: [] } });
    assert.match(ds[0].summary, /bash --label \u0430\u0440\u0433\u0443\u043c\u0435\u043d\u0442/); tasks.recoveryDelivered();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).tasks[0].description, 'bash --label \u0430\u0440\u0433\u0443\u043c\u0435\u043d\u0442');
  } finally { rmSync(root, { recursive: true }); }
});

test('M494 source and settings contain no Cyrillic product text', async () => {
  for (const file of readdirSync('src').filter(f => f.endsWith('.ts'))) {
    const text = readFileSync(join('src', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(text, /[\u0410-\u042f\u0430-\u044f\u0401\u0451]/, file);
  }
  let descriptors;
  await plugin({ settings: { define: d => { descriptors = d; return { get: async () => ({ authMode: 'desktop' }), onChange() {} }; } }, providers: { register() {} } });
  assert.equal(Object.keys(descriptors).length, 5);
  assert.equal(descriptors.checkStartPromotions.default, false);
  for (const d of Object.values(descriptors)) { assert.ok(d.label && d.description); assert.doesNotMatch(d.label + d.description, /[\u0410-\u042f\u0430-\u044f\u0401\u0451]/); }
});
