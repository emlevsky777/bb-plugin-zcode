import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { artifact } from './helpers.mjs';
import { validateRegistry, inspectCompatibility, bundleReader } from '../../scripts/provider/compat-level0.mjs';
const { optionalUserPlugins, pluginsWarning, applyUserPlugins } = await import(artifact ? '../../dist/user-plugins.js' : '../../src/user-plugins.ts');
const { createPluginDiscoveryView } = await import(artifact ? '../../dist/discovery-view.js' : '../../src/discovery-view.ts');
const { assertOfficialLaunchIsolation } = await import(artifact ? '../../dist/plugin-isolation.js' : '../../src/plugin-isolation.ts');
const { preparePersonalSettings } = await import(artifact ? '../../dist/personal-settings.js' : '../../src/personal-settings.ts');
const temp = () => mkdtempSync(join(tmpdir(), 'm496b-'));
let rawWrite = writeFileSync;
try { rawWrite = createRequire(import.meta.url)('original-fs').writeFileSync; } catch { /* Ordinary Node. */ }
const registry = JSON.parse(readFileSync(new URL('../../compat/touchpoints.json', import.meta.url), 'utf8'));

test('M496b discovery changing to source write disables only optional plugins and emits English warning', async () => {
  const root = temp();
  try {
    const user = join(root, 'user'), cwd = join(root, 'project'); mkdirSync(user); mkdirSync(cwd);
    const source = join(user, 'source.txt'); writeFileSync(source, 'unchanged');
    const view = createPluginDiscoveryView(user, cwd), warnings = [];
    try {
      const result = await optionalUserPlugins(true, async () => {
        execFileSync(process.execPath, ['--require', view.preload, '-e', `require('node:fs').writeFileSync(${JSON.stringify(source)},'changed')`], { encoding: 'utf8', stdio: 'pipe' });
        assert.fail('Fence must reject a newly introduced native write');
      }, warnings);
      assert.deepEqual(result, { enabled: false, plugins: [] }); assert.deepEqual(warnings, [pluginsWarning]);
      assert.equal(readFileSync(source, 'utf8'), 'unchanged');
      const home = join(root, 'own'), data = join(root, 'data'); preparePersonalSettings(home, data, cwd, user);
      const plan = applyUserPlugins(home, data, cwd, result.enabled, result.plugins);
      // The ordinary runtime view remains usable after optional discovery failed.
      const read = execFileSync(process.execPath, ['--require', plan.preload, '-e', `console.log(require('node:fs').readFileSync(${JSON.stringify(source)},'utf8'))`], { encoding: 'utf8' });
      assert.equal(read.trim(), 'unchanged');
      let called = false; await optionalUserPlugins(false, async () => { called = true; return []; }, warnings); assert.equal(called, false);
    } finally { view.cleanup(); }
  } finally { rmSync(root, { recursive: true }); }
});

test('M496b project view malformed native config stops rather than returning unsafe bytes; A45 no-MCP read creates own manifest', () => {
  const root = temp();
  try {
    const user = join(root, 'user'), cwd = join(root, 'project'), home = join(root, 'own'), data = join(root, 'data');
    mkdirSync(user); mkdirSync(cwd); preparePersonalSettings(home, data, cwd, user);
    const plan = applyUserPlugins(home, data, cwd, false), project = join(cwd, 'zcode.json'); writeFileSync(project, '{');
    const result = spawnSync(process.execPath, ['--require', plan.preload, '-e', `require('node:fs').readFileSync(${JSON.stringify(project)},'utf8')`], { encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /project config isolation is unavailable; thread stopped before input/);
    const source = join(data, 'cli/plugins/cache/zcode-plugins-official/no-mcp/1/.zcode-plugin/plugin.json');
    mkdirSync(dirname(source), { recursive: true }); writeFileSync(source, JSON.stringify({ name: 'no-mcp', version: '1' }));
    execFileSync(process.execPath, ['--require', plan.preload, '-e', `require('node:fs').readFileSync(${JSON.stringify(source)},'utf8')`]);
    assert.ok(existsSync(join(plan.pluginStore, 'runtime-manifests/no-mcp/1/.zcode-plugin/plugin.json')));
    assert.equal(assertOfficialLaunchIsolation(plan.pluginStore, plan.preload, { authority: 'session', plugins: [{ name: 'no-mcp' }] }).isolatedLaunchServers, 0);
    rmSync(join(plan.pluginStore, 'runtime-manifests'), { recursive: true });
    assert.throws(() => assertOfficialLaunchIsolation(plan.pluginStore, plan.preload, { authority: 'session', plugins: [{}] }), /launch isolation is unavailable.*thread stopped before input/);
  } finally { rmSync(root, { recursive: true }); }
});

test('M496b level0 schema rejects duplicates/traversal/unknown shape; installed strong anchors all found', () => {
  assert.equal(validateRegistry(registry), registry);
  for (const mutate of [r => r.touchpoints.push(r.touchpoints[0]), r => r.touchpoints[0].anchors[0].file = '../escape', r => r.touchpoints[0].anchors[0].strength = 'maybe', r => r.extra = true, r => r.touchpoints[0].code = []]) {
    const copy = structuredClone(registry); mutate(copy); assert.throws(() => validateRegistry(copy), /Invalid compatibility registry/);
  }
  const report = inspectCompatibility(registry); assert.equal(report.summary.notFound, 0);
  assert.ok(report.summary.weakAnchors > 0); assert.ok(report.affected.every(p => p.status === 'weak-anchor'));
});

test('M496b level0 copied CLI mutation identifies precisely the affected dependency and functions', () => {
  const root = temp();
  try {
    const file = 'Contents/Resources/glm/zcode.cjs', source = '/Applications/ZCode.app/' + file;
    mkdirSync(dirname(join(root, file)), { recursive: true }); cpSync(source, join(root, file));
    // Mutate only the chosen anchor, retaining the rest of the full copied bundle file.
    const target = registry.touchpoints.find(p => p.id === 'zcode-resident-skills');
    const anchor = target.anchors[0].text, bytes = readFileSync(join(root, file), 'utf8'); assert.ok(bytes.includes(anchor));
    writeFileSync(join(root, file), bytes.replaceAll(anchor, 'BROKEN_referenceCatalog'));
    const subset = { version: 1, touchpoints: registry.touchpoints.filter(p => p.anchors.every(a => a.file === file)) };
    const report = inspectCompatibility(subset, { zcode: root });
    assert.deepEqual(report.points.filter(p => p.status === 'not-found').map(p => p.id), [target.id]);
    assert.deepEqual(report.affected.find(p => p.id === target.id).functions, target.code);
  } finally { rmSync(root, { recursive: true }); }
});

test('M496b ASAR reader handles packed/unpacked/missing entries and truncated archives without execution', () => {
  const root = temp(), archive = join(root, 'Contents/Resources/app.asar');
  try {
    const payload = Buffer.from('packed anchor');
    const header = Buffer.from(JSON.stringify({ files: { 'packed.js': { size: payload.length, offset: '0' }, 'unpacked.js': { size: 8, unpacked: true } } }));
    const padding = (4 - (header.length % 4)) % 4, prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(8 + header.length + padding, 4); prefix.writeUInt32LE(4 + header.length + padding, 8); prefix.writeUInt32LE(header.length, 12);
    mkdirSync(dirname(archive), { recursive: true }); rawWrite(archive, Buffer.concat([prefix, header, Buffer.alloc(padding), payload]));
    mkdirSync(archive + '.unpacked'); writeFileSync(archive + '.unpacked/unpacked.js', 'unpacked');
    const read = bundleReader(root); assert.equal(read('Contents/Resources/app.asar/packed.js'), 'packed anchor'); assert.equal(read('Contents/Resources/app.asar/unpacked.js'), 'unpacked');
    assert.throws(() => read('Contents/Resources/app.asar/missing.js'), /Missing/);
    rawWrite(archive, Buffer.alloc(3)); assert.throws(() => bundleReader(root)('Contents/Resources/app.asar/packed.js'), /Truncated/);
  } finally { rmSync(root, { recursive: true }); }
});
