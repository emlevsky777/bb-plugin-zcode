import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { api, plugin } from './helpers.mjs';

test('M493 Spotlight and both Applications directories: deterministic, validated, missing and unavailable', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'm493-apps-')));
  const dirs = [join(root, 'Applications'), join(root, 'home/Applications')];
  const bundles = dirs.map(d => join(d, 'Renamed ZCode.app'));
  const other = join(root, "Other place/ZCode's copy.app");
  const add = p => { mkdirSync(join(p, 'Contents'), { recursive: true }); writeFileSync(join(p, 'Contents/Info.plist'), 'dev.zcode.app'); };
  const options = { applicationDirs: dirs, bundleId: p => readFileSync(join(p, 'Contents/Info.plist'), 'utf8'), spotlight: () => { throw Error('Spotlight disabled'); } };
  try {
    assert.equal(api.findZCode(options).bundle, null);
    assert.match(api.findZCode(options).message, /Spotlight.*dev.zcode.app.*Applications/);
    add(bundles[1]); assert.equal(api.findZCode(options).bundle, bundles[1]);
    add(bundles[0]); const both = api.findZCode(options); assert.equal(both.bundle, bundles[0]); assert.equal(both.method, 'applications'); assert.match(both.message, /Selected deterministically/);
    rmSync(bundles[1], { recursive: true }); assert.equal(api.findZCode(options).bundle, bundles[0]);
    add(other); const found = api.findZCode({ ...options, spotlight: () => [other, bundles[0], other] });
    assert.equal(found.bundle, bundles[0]); assert.equal(found.method, 'mdfind'); assert.equal(found.candidates.length, 2);
    rmSync(bundles[0], { recursive: true }); assert.equal(api.findZCode({ ...options, spotlight: () => [other] }).bundle, other);
    writeFileSync(join(other, 'Contents/Info.plist'), 'unrelated'); assert.equal(api.findZCode({ ...options, spotlight: () => [other, '/stale.app', 'relative.app'] }).bundle, null);
    assert.equal(api.bbBundle('/Elsewhere/My bb.app/Contents/MacOS/bb'), '/Elsewhere/My bb.app'); assert.equal(api.bbBundle('/usr/bin/node'), null);
  } finally { rmSync(root, { recursive: true }); }
});

test('M493 complete command quotes all paths; no PATH zcode; all login surfaces agree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'm493-command-'));
  try {
    const paths = api.pathsForZCode(join(root, "ZCode's $(touch wrong) `echo bad`.app"));
    const expected = JSON.stringify([paths.builtin, paths.script, 'login', 'zai']);
    mkdirSync(resolve(paths.executable, '..'), { recursive: true });
    writeFileSync(paths.executable, '#!/bin/sh\nprintf \'%s\\n\' "$ZCODE_BUILTIN_PROVIDER_CONFIG_FILE" "$@"\n', { mode: 0o700 });
    const out = execFileSync('/bin/zsh', ['-f', '-c', api.loginCommand(paths)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim().split('\n');
    assert.equal(JSON.stringify(out), expected);
    let descriptors, registration;
    await plugin({ settings: { define: d => { descriptors = d; return { get: async () => ({ authMode: 'cli', catalogueRefresh: 87 }), onChange() {} }; } }, providers: { register: r => { registration = r; } } });
    assert.equal(descriptors.catalogueRefresh, undefined); assert.equal(registration.experimental_bridgeOptions.catalogueRefresh, 0);
    assert.equal(registration.deriveProviderOptions({ settings: { catalogueRefresh: 87 } }).catalogueRefresh, 87);
    assert.equal(registration.strings.signInHint, api.signInHint()); assert.match(descriptors.authMode.description, /existing ZCode login/);
    assert.ok(registration.strings.expiredHint.includes(api.signInHint()));
    assert.equal(api.authRecovery().recovery.message, api.signInHint());
  } finally { rmSync(root, { recursive: true }); }
});

for (const persistent of [false, true]) test(`M493 login file appears, changes, disappears: automatic catalogue refresh (${persistent})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'm493-login-')), builtin = join(root, 'builtin.json'); writeFileSync(builtin, '{}');
  const auth = new api.ReadOnlyAuth(join(root, 'credentials.json')); let launches = 0;
  const runtime = api.createNativeServices(join(root, 'service'), { auth, catalogueCache: persistent,
    discovery: () => ({ installed: true, supported: true, sha256: 'synthetic', version: 'synthetic' }),
    paths: { executable: process.execPath, script: resolve('tests/provider/fake-v4.mjs'), builtin },
    configure: async child => { launches++; await child.request('runtime/capabilities', {}); } });
  const put = identity => writeFileSync(auth.path, JSON.stringify({ [`account-provider:${api.accountProviderId}:identity`]: identity,
    [`account-provider:coding-plan:${api.accountProviderId}:account:${identity}:api-key`]: 'SYNTHETIC_M493_KEY' }));
  try {
    assert.equal((await runtime.services.health()).health.status, 'unauthenticated');
    await assert.rejects(runtime.services.models(undefined, 'cli', 87), e => e.kind === 'unauthenticated'); assert.equal(launches, 0);
    put('first'); const before = readFileSync(auth.path); const first = await runtime.services.models(undefined, 'cli', 87);
    assert.ok(first.models.length); assert.equal(launches, 1); assert.deepEqual(readFileSync(auth.path), before);
    await runtime.services.models(undefined, 'cli', 87); assert.equal(launches, 1);
    put('changed'); await runtime.services.models(undefined, 'cli', 87); assert.equal(launches, 2);
    unlinkSync(auth.path); await assert.rejects(runtime.services.models(undefined, 'cli', 87), e => e.kind === 'unauthenticated');
    put('return'); await runtime.services.models(undefined, 'cli', 87); assert.equal(launches, 3);
  } finally { await runtime.close(); rmSync(root, { recursive: true }); }
});

// Modes and provider IDs from Desktop 3.14.4 builtin config / CLI 0.16.9 enum Hji.
const plans = [ ['account:zai-start-plan', 'start-plan', 'zai', 'Z.ai Start Plan'],
  ['account:zai-team-coding-plan', 'team-coding-plan', 'zai', 'Z.ai Team Coding Plan'],
  ['account:zai-individual-coding-plan', 'off-peak', 'zai', 'Z.ai off-peak'],
  ['account:bigmodel-individual-coding-plan', 'individual-coding-plan', 'bigmodel', 'BigModel individual Coding Plan'] ];
for (const [providerId, mode, accountType, label] of plans) test(`M493 unsupported native modelSelection: ${label}`, () => {
  const auth = new api.ReadOnlyAuth('/never-read');
  const params = { providerId, accountAccess: { type: 'zhipu-account', mode, accountType, entitled: true }, modelSelection: { providerId, modelId: 'GLM-5.3' }, workspace: {} };
  assert.throws(() => auth.headers(params, 'session', '/workspace', 'GLM-5.3'), e => e instanceof api.UnsupportedPlanError && e.plan === label && /only the individual Coding Plan from Z.ai/.test(e.message));
  assert.equal(auth.reads, 0);
});
test('M493 unsupported shared-store identities return named health refusal before catalogue launch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'm493-plan-store-')), auth = new api.ReadOnlyAuth(join(root, 'credentials.json'));
  let launches = 0;
  const runtime = api.createNativeServices(join(root, 'service'), { auth,
    discovery: () => ({ installed: true, supported: true, sha256: 'synthetic', version: 'synthetic' }),
    compatibility: () => ({ message: null }), configure: async () => { launches++; } });
  try {
    for (const [providerId, mode, accountType, label] of plans.filter(p => p[1] !== 'off-peak')) {
      writeFileSync(auth.path, JSON.stringify({ [`account-provider:${providerId}:identity`]: 'SYNTHETIC_IDENTITY' }));
      const before = readFileSync(auth.path);
      assert.ok((await runtime.services.health()).health.statusMessage.includes(label));
      await assert.rejects(runtime.services.models(), e => e instanceof api.UnsupportedPlanError && e.plan === label);
      assert.deepEqual(readFileSync(auth.path), before);
    }
    assert.equal(launches, 0);
  } finally { await runtime.close(); rmSync(root, { recursive: true }); }
});
