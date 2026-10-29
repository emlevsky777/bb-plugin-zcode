import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api } from './helpers.mjs';
import { skillsConfigureParamsSchema } from '@get-bb/plugin-sdk/provider-bridge';

test('c1 delivery is authoritative, durable, once; unknown dispatch and rejected dispatch differ', () => {
  const dir = mkdtempSync('/tmp/c1-knowledge-'), file = join(dir, 'state.json');
  try {
    let k = new api.SessionKnowledge(file);
    assert.equal(k.prepare('command1', 'instructions', 'first'), 'instructions\n\nfirst');
    k = new api.SessionKnowledge(file);
    assert.equal(k.prepare('command2', 'instructions', 'next'), 'next');
    k.observe({ rows: { window: [{ kind: 'turnHeader', sourceCommandId: 'other' }] } });
    assert.equal(k.delivered, false);
    k.observe({ rows: { window: [{ kind: 'turnHeader', sourceCommandId: 'command1' }] } });
    k = new api.SessionKnowledge(file);
    assert.equal(k.prepare('command2', 'changed', 'second'), 'second');
    assert.equal(k.prepare('command3', 'changed', 'model switch'), 'model switch');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).commandId, 'command1');
    const rejected = new api.SessionKnowledge(); rejected.prepare('r1', 'block', 'first'); rejected.rejected('r1');
    assert.equal(rejected.prepare('r2', 'block', 'retry'), 'block\n\nretry');
  } finally { rmSync(dir, { recursive: true }); }
});

test('c1 SDK .79 roots: native bundled/plugin/name/path exclusions, aliases, ordered bb winners, stale and empty roots', () => {
  const dir = mkdtempSync('/tmp/c1-skills-');
  const skill = (folder, name) => { const path = join(dir, folder, 'SKILL.md'); mkdirSync(join(dir, folder)); writeFileSync(path, `---\nname: ${name}\ndescription: fixture\n---\ncontent\n`); return path; };
  try {
    const a = skill('a', 'only'), b = skill('b', 'only'), native = skill('native', 'builtin'), plugin = skill('plugin', 'guide'), alias = join(dir, 'alias'); symlinkSync(join(dir, 'native'), alias);
    const roots = skillsConfigureParamsSchema.parse({ roots: [
      { id: 'a', path: join(dir, 'a'), skills: [{ name: 'only', description: 'first' }] },
      { id: 'b', path: join(dir, 'b'), skills: [{ name: 'only', description: 'second' }] },
      { id: 'native', path: alias, skills: [{ name: 'builtin', description: 'duplicate' }] },
      { id: 'plugin', path: join(dir, 'plugin'), skills: [{ name: 'zcode-guide:guide', description: 'duplicate' }] },
      { id: 'collision', path: join(dir, 'b'), skills: [{ name: 'builtin', description: '', filePath: b }] },
      { id: 'stale', path: join(dir, 'missing'), skills: [{ name: 'stale', description: '' }] },
      { id: 'empty', path: dir, skills: [] }
    ] }).roots;
    writeFileSync(a, readFileSync(a, 'utf8') + 'x'.repeat(100000));
    const result = api.bbOnlySkills(roots, { skills: [{ name: 'builtin', path: native, scope: 'system', source: 'bundled' }, { name: 'guide', qualifiedName: 'zcode-guide:guide', path: plugin, scope: 'system', source: 'plugin' }] });
    assert.deepEqual(result.skills, [{ name: 'only', description: 'first', path: realpathSync(a) }]);
    assert.deepEqual(result.excluded.map(s => s.reason), ['bb-root-order-winner', 'native-canonical-path', 'native-canonical-path', 'native-name-winner', 'unavailable-file']);
    assert.equal(api.skillsBlock(result.skills).split('(file: ').length, 2);
    assert.deepEqual(api.bbOnlySkills([], { skills: [] }).skills, []);
    const large = 'x'.repeat(100000); assert.ok(api.skillsBlock([{ name: 'large', description: large, path: a }]).includes(large));
  } finally { rmSync(dir, { recursive: true }); }
});

test('c1 selected bb skill uses a file tool, without native Skill registration', async () => {
  const result = await api.convertMentions([{ type: 'text', text: '$only', mentions: [{ start: 0, end: 5, resource: { kind: 'command', name: 'only', source: 'skill', origin: 'user', trigger: '$' } }] }], async m => ({ ...m, path: '/actual/SKILL.md', loadWith: 'file' }));
  assert.ok(result.input.at(-1).text.includes('file tool'));
  assert.equal(result.input.some(i => i.text.includes('Skill tool')), false);
  assert.equal(api.bridgeCapabilities.skills.configure, true);
});

test('c1 native compact active-chain semantics: manual loss, automatic preserved tail, one frozen redelivery', () => {
  const msg = (id, text) => ({ info: { id, role: 'user' }, parts: [{ type: 'text', text }] });
  const old = msg('old', 'bb block'), summary = msg('summary', 'summary');
  const boundary = { info: { id: 'boundary', role: 'user' }, parts: [{ type: 'compaction', compactBoundary: {} }] };
  assert.deepEqual(api.activeNativeMessages([old, boundary, summary]), [boundary, summary]);
  const k = new api.SessionKnowledge(); k.prepare('send1', 'bb block', 'first');
  k.observe({ rows: { window: [{ kind: 'turnHeader', sourceCommandId: 'send1' }, { kind: 'timelineMarker', rowId: 3, turnId: 'compact1', marker: { type: 'compact', origin: 'manual', status: 'success' } }] } });
  assert.equal(k.needsReconcile, true); assert.equal(k.reconcile([old, boundary, summary]), false);
  assert.equal(k.prepare('send2', 'changed block', 'next'), 'bb block\n\nnext');
  assert.equal(k.prepare('send3', 'changed block', 'third'), 'third');
  k.observe({ rows: { window: [{ kind: 'timelineMarker', rowId: 3, turnId: 'compact1', marker: { type: 'compact', origin: 'manual', status: 'success' } }] } });
  assert.equal(k.needsReconcile, false);
  const auto = { info: { id: 'auto', role: 'user' }, parts: [{ type: 'compaction', compactBoundary: { preservedSegment: { headMessageId: 'old', tailMessageId: 'old', anchorMessageId: 'summary' } } }] };
  assert.deepEqual(api.activeNativeMessages([old, auto, summary]), [auto, summary, old]);
  assert.equal(k.reconcile([old, auto, summary]), true);
  assert.equal(k.prepare('send4', 'changed', 'after auto'), 'after auto');
});

test('c1 active-chain fixture matches pinned .16.9/.17.0 compact hydration, and native runtime drops real-user prefix', { skip: !existsSync('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs') }, () => {
  const source = readFileSync('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs', 'utf8');
  const extract = (name, next) => { const start = source.indexOf('function ' + name + '('), end = source.indexOf('function ' + next + '(', start); assert.ok(start >= 0 && end > start); return source.slice(start, end); };
  // Execute only the pinned pure hydration functions; installed bytes are not
  // copied into Git. Runtime token invalidation does not change user content.
  const digest = createHash('sha256').update(source).digest('hex');
  const native17 = digest === '97490d0f06a7a225d54d47817acf4b4859cdb268b59f2490caaeda982bef063a';
  assert.ok(native17 || digest === 'b816e38656e70fb585fe2ab1ea010da89cda928dac1ccb5d83255fd18796da6e', 'Unreviewed native compaction implementation');
  const hydrate = native17
    ? new Function('qgt', source.slice(source.indexOf('function Qwn('), source.indexOf('var tkn=', source.indexOf('function Qwn('))) + '; return Qwn;')(() => ({}))
    : new Function('eht', extract('$vn', 'Wvn') + '; return $vn;')(() => ({}));
  const first = { info: { id: 'first', role: 'user' }, parts: [{ type: 'text', text: 'bb block' }] };
  const summary = { info: { id: 'summary', role: 'user' }, parts: [{ type: 'text', text: 'summary' }] };
  for (const preserved of [undefined, { headMessageId: 'first', tailMessageId: 'first', anchorMessageId: 'summary' }]) {
    const boundary = { info: { id: 'boundary', role: 'user' }, parts: [{ type: 'compaction', compactBoundary: { preservedSegment: preserved } }] };
    const messages = [first, boundary, summary]; assert.deepEqual(api.activeNativeMessages(messages), hydrate(messages, 1, true));
  }
  const prefixCount = new Function(...(native17 ? ['Tm', 'Ala', 'Pla', 'Ela'] : ['xm', 'jca', 'Bca', 'qu']),
    native17 ? extract('PT', 'Ela') + '; return PT;' : extract('wT', 'ix') + '; return wT;')(
    e => e.kind === 'attachment', e => e.message, e => e.metadata, content => content);
  const clone = value => structuredClone(value);
  const postCompact = new Function(...(native17 ? ['PT', '_kt', 'FLa'] : ['wT', 'mSt', 'zNa']),
    native17 ? extract('fjo', 'mjo') + '; return fjo;' : extract('TOo', 'IOo') + '; return TOo;')(prefixCount, clone, clone);
  const nativePrefix = { message: { role: 'user', content: 'native context' }, metadata: { source: 'context_prefix' } };
  const bbUser = { message: { role: 'user', content: '[bb session instructions]\nbb block' }, metadata: { source: 'real_user' } };
  const result = postCompact([nativePrefix, bbUser], { message: { role: 'user', content: 'summary' } });
  assert.equal(result.length, 2); assert.ok(!JSON.stringify(result).includes('bb block'));
});

test('c1 actual bridge config timing, ordinary/steer/model changes, process restart/cold resume keep one delivered block', async () => {
  const root = realpathSync(mkdtempSync('/tmp/c1-bridge-')), sessions = join(root, 'sessions.json'), store = join(root, 'knowledge.json');
  const skill = join(root, 'only'); mkdirSync(skill); writeFileSync(join(skill, 'SKILL.md'), '---\nname: only\ndescription: fixture\n---\nRead me.');
  const options = { permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null, model: 'GLM-5.3', reasoningLevel: 'high', instructions: 'x'.repeat(70000), envVars: {} };
  const configure = { roots: [{ id: 'fixture', path: skill, skills: [{ name: 'only', description: 'fixture' }] }] };
  const services = { prepare: async () => ({ launch: { executable: process.execPath, args: [resolve('tests/provider/fake-v4.mjs'), 'v4', sessions], cwd: root, env: api.childEnvironment(process.env, { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }) }, auth: new api.ReadOnlyAuth(join(root, 'missing')), configure: async c => { await c.request('runtime/capabilities', {}); }, knowledgeStore: store, mentionCatalogue: async () => ({ skills: [] }) }), validateSelection: async () => {} };
  let bridge, output = [], ordinal = 0;
  const startBridge = () => { output = []; bridge = api.createZCodeBridge(services, m => output.push(m)); };
  const rpc = async (method, params) => { const id = ++ordinal; bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params })); for (let i = 0; i < 400; i++) { const response = output.find(m => m.id === id); if (response) { assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result; } await delay(10); } throw Error('fixture timeout'); };
  const current = () => Object.values(JSON.parse(readFileSync(sessions, 'utf8')))[0];
  try {
    startBridge(); await rpc('skills/configure', configure);
    const identity = await rpc('thread/start', { threadId: 'thr_2222222222', cwd: root, options, instructionMode: 'append', dynamicTools: [], disallowedTools: [] });
    const base = { threadId: 'thr_2222222222', providerThreadId: identity.providerThreadId, options, clientRequestId: 'creq_2222222222' };
    await rpc('turn/start', { ...base, input: [{ type: 'text', text: 'first' }] }); await delay(100);
    assert.ok(current().lastSendText.includes('[bb skills]\n')); assert.ok(current().lastSendText.includes('(file: ' + join(skill, 'SKILL.md') + ')'));
    await rpc('skills/configure', { roots: [] });
    await rpc('turn/start', { ...base, clientRequestId: 'creq_3333333333', options: { ...options, instructions: 'changed', model: 'GLM-5.3-Flash' }, input: [{ type: 'text', text: '/wait-for-interrupt' }] }); await delay(100);
    assert.equal(current().lastSendText, '/wait-for-interrupt');
    const header = current().rows.window.find(r => r.kind === 'turnHeader' && r.state === 'running');
    await rpc('turn/steer', { ...base, clientRequestId: 'creq_4444444444', expectedTurnId: header.turnId, input: [{ type: 'text', text: 'guide' }] }); await delay(250);
    assert.equal(current().steerCommands.at(-1).payload.text, 'guide');
    assert.equal(output.some(m => m.method === 'session/replaced'), false);
    await bridge.close(); startBridge(); await rpc('skills/configure', { roots: [] });
    await rpc('thread/resume', { ...base, cwd: root, instructionMode: 'append', dynamicTools: [], disallowedTools: [] });
    await rpc('turn/start', { ...base, clientRequestId: 'creq_5555555555', input: [{ type: 'text', text: 'cold' }] }); await delay(100);
    assert.equal(current().lastSendText, 'cold');
    assert.equal(JSON.parse(readFileSync(store, 'utf8')).skills[0].name, 'only');
  } finally { await bridge?.close(); rmSync(root, { recursive: true }); }
});
