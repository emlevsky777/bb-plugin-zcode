import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitizeInheritedChildProcessEnv } from '@get-bb/plugin-sdk/provider-bridge';
import { api, plugin } from './helpers.mjs';

const options = { permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null };
test('O138 launch inherits the same ordinary environment as native Codex without a storage override', () => {
  const parent = { HOME: '/user', PATH: '/user/bin', USER: 'fixture', SHELL: '/bin/zsh', CUSTOM_CONTEXT: 'fixture',
    BB_PROVIDER_BRIDGE_RECORD_DIR: '/internal', NODE_ENV: 'development', ZCODE_STORAGE_DIR: '/obsolete' };
  const expected = sanitizeInheritedChildProcessEnv({ env: parent }); delete expected.ZCODE_STORAGE_DIR;
  assert.deepEqual(api.childEnvironment(parent, {}), expected);
  const actual = api.childEnvironment(parent, { ZCODE_SESSION_DB_PATH: '/bb/db', ZCODE_DATA_BASE_DIR: '/bb/login', ZCODE_LOG_DIR: '/bb/log' });
  assert.equal(actual.HOME, '/user'); assert.equal(actual.CUSTOM_CONTEXT, 'fixture');
  assert.equal(actual.ZCODE_STORAGE_DIR, undefined); assert.equal(actual.ZCODE_SESSION_DB_PATH, '/bb/db');
});

test('O138 preparation leaves user configuration and instructions unchanged; simple session binding and DB paths remain stable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'm498b-')), home = join(root, 'user'), data = join(root, 'bb'), cwd = join(root, 'project');
  const config = join(home, '.zcode/cli/config.json'), instructions = join(home, '.zcode/AGENTS.md'), desktop = join(home, '.zcode/v2/settings.json');
  for (const file of [config, instructions, desktop]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'USER_SENTINEL'); }
  mkdirSync(cwd); const builtin = join(root, 'builtin.json'); writeFileSync(builtin, '{}');
  const auth = new api.ReadOnlyAuth(join(root, 'missing')); auth.read = () => ({ apiKey: 'SYNTHETIC_ONLY' });
  const rt = api.createNativeServices(data, { auth, personalHome: home, discovery: () => ({ installed: true, supported: true, version: 'fixture', sha256: 'fixture' }),
    paths: { executable: process.execPath, script: resolve('tests/provider/fake-v4.mjs'), builtin }, configure: async () => {} });
  try {
    const legacy = api.sessionDataDir(data, cwd, 'legacy'), binding = join(legacy, 'bb-binding.json');
    mkdirSync(legacy, { recursive: true }); writeFileSync(binding, JSON.stringify({ threadId: 'legacy', cwd: realpathSync(cwd), nativeSessionId: 'native-legacy' }));
    const db = join(legacy, 'db.sqlite'); mkdirSync(dirname(db), { recursive: true }); writeFileSync(db, 'OLD_HISTORY');
    const setup = await rt.services.prepare(cwd, api.executionOptions({ ...options, instructions: 'BB_PRIVATE' }), { threadId: 'legacy', providerThreadId: 'native-legacy' });
    assert.equal(setup.launch.env.HOME, home); assert.equal(setup.launch.env.ZCODE_SESSION_DB_PATH, db);
    assert.equal(setup.launch.env.ZCODE_DATA_BASE_DIR, undefined, 'MCP OAuth must use the shared Desktop credential store');
    assert.equal(readFileSync(db, 'utf8'), 'OLD_HISTORY');
    for (const file of [config, instructions, desktop]) assert.equal(readFileSync(file, 'utf8'), 'USER_SENTINEL');
    assert.equal(existsSync(join(legacy, '.zcode/AGENTS.md')), false);
    assert.equal(setup.launch.env.ZCODE_STORAGE_DIR, undefined);
    assert.equal(setup.backgroundTaskStore, join(legacy, 'bb-background-tasks.json'));
    assert.equal(setup.launch.args.includes('--require'), false);
  } finally { await rt.close(); rmSync(root, { recursive: true }); }
});

test('removed isolation settings are unsupported; plugin no longer publishes the switches or host sync', async () => {
  assert.throws(() => api.executionOptions({ ...options, providerOptions: { useUserMcp: true, useZCodePlugins: false } }), /providerOptions/);
  let descriptors, registration;
  await plugin({ settings: { define: d => { descriptors = d; return { get: async () => ({ authMode: 'cli', useZCodePlugins: true, useUserMcp: true }), onChange() {} }; } },
    providers: { register: r => { registration = r; } } });
  assert.equal(descriptors.useZCodePlugins, undefined); assert.equal(descriptors.useUserMcp, undefined);
  assert.equal(registration.experimental_bridgeOptions, undefined);
});
