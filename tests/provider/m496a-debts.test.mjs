import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { api, artifact } from './helpers.mjs';
const { redactHomePath, formatProblemReport } = await (artifact ? import('../../dist/problem-report.js') : import('../../src/problem-report.ts'));

test('M496a Desktop version reads XML and actual binary plist; unavailable remains unknown', () => {
  const root = mkdtempSync('/tmp/m496a-plist-'), file = join(root, 'Info.plist');
  try {
    writeFileSync(file, '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>3.14.4</string></dict></plist>');
    assert.equal(api.desktopVersion(file), '3.14.4');
    execFileSync('/usr/bin/plutil', ['-convert', 'binary1', file]);
    assert.equal(readFileSync(file).subarray(0, 8).toString(), 'bplist00');
    assert.equal(api.desktopVersion(file), '3.14.4');
    assert.equal(api.desktopVersion(join(root, 'missing')), null);
  } finally { rmSync(root, { recursive: true }); }
});

test('M496a report hides home in Applications paths without replacing sibling prefixes', () => {
  assert.equal(redactHomePath('/home/private/Applications/ZCode.app', '/home/private'), '~/Applications/ZCode.app');
  assert.equal(redactHomePath('/home/private-other/Applications/ZCode.app', '/home/private'), '/home/private-other/Applications/ZCode.app');
  assert.equal(redactHomePath('/Applications/ZCode.app', '/home/private'), '/Applications/ZCode.app');
  assert.equal(redactHomePath(null, '/home/private'), null);
  const output = formatProblemReport({ bb: null, ZCode: null, CLI: null, plugin: '0.0.0', macOS: 'unknown',
    state: 'installed', ZCodePath: join(homedir(), 'Applications/ZCode.app'), cliLogin: 'not set', events: [] }, {});
  assert.equal(output.includes('ZCodePath'), false);
  assert.equal(output.includes(homedir()), false);
});

test('SDK .79 preserves native effort identifiers and their selected default', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/m441-catalogue.json', import.meta.url), 'utf8'));
  const normal = structuredClone(fixture.models[0]), extra = structuredClone(fixture.models[1]);
  extra.reasoning.levels.push({ value: 'native-future' });
  const mapped = api.mapNativeModels([normal, extra], fixture.nativeDefault);
  assert.equal(mapped.length, 2);
  assert.ok(mapped[1].supportedReasoningEfforts.some(e => e.reasoningEffort === 'native-future'));
  assert.equal(mapped[1].defaultReasoningEffort, extra.reasoning.defaultLevel);
  extra.reasoning.defaultLevel = 'native-future';
  assert.deepEqual(api.mapNativeModels([normal, extra], fixture.nativeDefault).map(m => m.id), [normal.ref.modelId, extra.ref.modelId]);
  assert.equal(api.mapNativeModels([extra], extra.ref)[0].defaultReasoningEffort, 'native-future');
});

test('M496a mention CLI once per native session; resume/config replacement reload; stale file fails locally', async () => {
  const cwd = mkdtempSync('/tmp/m496a-mentions-'), output = [], observations = [], counter = join(cwd, 'calls');
  const path = join(cwd, 'SKILL.md'); writeFileSync(path, 'fixture');
  const options = { ...JSON.parse(readFileSync(new URL('./fixtures/bb-real-inputs.json', import.meta.url), 'utf8')).fixtures[0].request.params.options, envVars: {} };
  const row = { name: 'chosen', scope: 'project', source: 'zcode', path };
  let failCatalogue = true;
  const services = {
    prepare: async () => ({ launch: { executable: process.execPath, args: [resolve('tests/provider/fake-v4.mjs'), 'v4', join(cwd, 'sessions.json')], cwd,
      env: api.childEnvironment(process.env, { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }) }, auth: new api.ReadOnlyAuth(join(cwd, 'missing')),
      mentionCatalogue: async side => { if (failCatalogue) { failCatalogue = false; throw Error('Native mention catalogue unavailable'); }
        return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
        'import{appendFileSync}from"node:fs";appendFileSync(process.argv[1],"call\\n");console.log(process.argv[2]);', counter, JSON.stringify({ [side]: [row] })],
      { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })); },
      configure: async child => { await child.request('runtime/capabilities', {}); const request = child.request.bind(child);
        child.request = (method, p) => method === 'skills/referenceCatalog' ? Promise.resolve({ authority: 'session', skills: [{ ...row, scope: 'workspace', enabled: true }] }) : request(method, p); } }),
    observe: e => observations.push(e), health: async () => ({}), installation: async () => ({}), models: async () => ({ models: [] }), validateSelection: async () => {},
  };
  const bridge = api.createZCodeBridge(services, m => output.push(m)); let ordinal = 0;
  const rpc = async (method, params) => { const id = ++ordinal; bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    for (let i = 0; i < 800; i++) { const m = output.find(m => m.id === id); if (m) return m; await delay(10); } throw Error('Fixture timeout'); };
  const input = [{ type: 'text', text: '$chosen', mentions: [{ start: 0, end: 7, resource: { kind: 'command', name: 'chosen', source: 'skill', trigger: '$', origin: 'project', label: 'chosen', argumentHint: null } }] }];
  const count = () => readFileSync(counter, 'utf8').trim().split('\n').length;
  const start = { threadId: 'own', cwd, options, instructionMode: 'append' };
  try {
    const first = await rpc('thread/start', start); assert.ok(first.result); const native = first.result.providerThreadId;
    const boundaries = () => output.flatMap(m => m.params?.deltas ?? []).filter(d => d.kind === 'turn.boundary').length;
    const send = async opts => { const before = boundaries();
      const result = await rpc('turn/start', { threadId: 'own', providerThreadId: native, options: opts ?? options, clientRequestId: 'creq_2222222222', input });
      if (!result.error) { for (let i = 0; i < 800 && boundaries() === before; i++) await delay(10); assert.ok(boundaries() > before, 'turn completed before next input'); }
      return result; };
    assert.match((await send()).error.message, /catalogue unavailable/);
    assert.ok((await send()).result); assert.ok((await send()).result); assert.equal(count(), 1);
    const stopped = await rpc('thread/stop', { threadId: 'own', providerThreadId: native, intent: 'release', activeTurnId: null }); assert.ok(stopped.result, JSON.stringify(stopped));
    const resumed = await rpc('thread/resume', { ...start, providerThreadId: native }); assert.ok(resumed.result, JSON.stringify(resumed));
    assert.ok((await send()).result); assert.equal(count(), 2);
    assert.ok((await send({ ...options, providerOptions: { providerSubagentsEnabled: false } })).result); assert.equal(count(), 3);
    unlinkSync(path); assert.match((await send({ ...options, providerOptions: { providerSubagentsEnabled: false } })).error.message, /unavailable/); assert.equal(count(), 3);
    assert.deepEqual(observations.filter(e => e.event === 'mention-catalogue').map(e => e.hit), [false, true, false, false, true]);
  } finally { await bridge.close(); rmSync(cwd, { recursive: true }); }
});
