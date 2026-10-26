import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

test('M494 version A, second A, B, checked; health is concise without a CLI login action', async () => {
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
    r = runtime(); assert.equal(r.services.compatibilityWarning(), null);
    combination = { ...combination, bb: '9.2.0' }; assert.match(r.services.compatibilityWarning(), /9.2.0/);
    combination = checked; assert.equal(r.services.compatibilityWarning(), null);
    put(); const ready = (await r.services.health()).health;
    assert.equal(ready.statusMessage, 'Ready. ZCode: /fixture/ZCode.app.'); assert.equal(ready.loginCommand, null);
    r.services.observe({ event: 'catalogue-cache-recovery' });
    assert.equal((await r.services.health()).health.statusMessage, ready.statusMessage);
    combination = { ...combination, bb: '9.2.0' }; assert.match((await r.services.health()).health.statusMessage, /Ready.*not been checked/);
    unlinkSync(auth.path); assert.match((await r.services.health()).health.statusMessage, /Open ZCode Desktop and sign in again/);
    installed = false; assert.equal((await r.services.health()).health.status, 'not_installed');
    assert.doesNotMatch((await r.services.health()).health.statusMessage, /Open ZCode Desktop/); await r.close();
  } finally { rmSync(root, { recursive: true }); }
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
  assert.equal(Object.keys(descriptors).length, 4);
  for (const d of Object.values(descriptors)) { assert.ok(d.label && d.description); assert.doesNotMatch(d.label + d.description, /[\u0410-\u042f\u0430-\u044f\u0401\u0451]/); }
});
