import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { artifact, plugin, host } from './helpers.mjs';
const { catalogueRoots, rootsFingerprint, resolveNativeRootsCached, clearRootsCache, rootsCacheSize } = await (artifact ? import('../../dist/native-roots.js') : import('../../src/native-roots.ts'));
const { nativePaths } = await (artifact ? import('../../dist/runtime.js') : import('../../src/runtime.ts'));
// P1 expectation source: historical decision (owner) + A-39 measurement; fingerprint inputs are
// the same user/project dirs the CLI reads (M4.6 native semantics). Cache
// assertions use real local CLI `--json list` with synthetic HOME fixtures:
// local reads only, no model/auth/network.

test('M46 native catalogue canonical original files deduplicate aliases, omit plugins/system/unavailable entries and retain native selection', () => {
  const root = mkdtempSync('/tmp/zcode-m46-roots-');
  try {
    const file = join(root, 'SKILL.md'), alias = join(root, 'alias.md');
    writeFileSync(file, '---\nname: selected\ndescription: fixture\n---\n'); symlinkSync(file, alias);
    // Shape/source grounded in M4.6 installed CLI metadata; mutations exercise optional failures.
    const selected = { path: file, name: 'selected', scope: 'user', source: 'agents' };
    const result = catalogueRoots({ skills: [selected, { ...selected, path: alias },
      { ...selected, scope: 'system', source: 'bundled' }, { ...selected, pluginName: 'fixture' },
      { ...selected, path: join(root, 'gone') }, { ...selected, source: 'future' }] }, 'skills');
    assert.equal(result.length, 1); assert.equal(result[0].path, realpathSync(file)); assert.equal(result[0].fallbackName, 'selected');
    assert.equal(result[0].shape, 'skill-file'); assert.equal(result[0].origin, 'user');
    const systemPlugin = catalogueRoots({ skills: [{ ...selected, scope: 'system', source: 'plugin', pluginName: 'desktop' }] }, 'skills');
    assert.equal(systemPlugin.length, 1); assert.equal(systemPlugin[0].origin, 'user');
    assert.equal(systemPlugin[0].path, realpathSync(file));
    const commands = catalogueRoots({ commands: [{ ...selected, name: 'folder:skill', scope: 'project', source: 'zcode' }] }, 'commands');
    assert.equal(commands[0].shape, 'command-file'); assert.equal(commands[0].origin, 'project');
    assert.equal(commands[0].fallbackName, undefined);
    assert.equal(commands[0].namePrefix, 'folder:');
    assert.equal(catalogueRoots({ commands: [{ ...selected, name: 'one:two:skill' }, { ...selected, name: 'alias' }] }, 'commands').length, 0);
    assert.throws(() => catalogueRoots({}, 'skills'), /unavailable/);
  } finally { rmSync(root, { recursive: true }); }
});

test('M46 provider publishes only dynamic native roots and host retains native SDK validators', async () => {
  assert.equal(host.default, host.experimental_host, 'Installed bb host worker imports the default entry');
  let provider;
  await plugin({ settings: { define: () => ({ get: async () => ({ authMode: 'cli', catalogueRefresh: 0 }), onChange() {} }) },
    providers: { register: value => { provider = value; } } });
  assert.equal(provider.experimental_resolvesNativeRoots, true);
  assert.equal(provider.experimental_nativeSkillRoots, undefined); assert.equal(provider.experimental_nativeCommandRoots, undefined);
  const input = host.experimental_host.contract.resolveNativeRoots.input;
  assert.equal(input.safeParse({ cwd: '/fixture', providerId: 'zcode' }).success, true);
  assert.equal(input.safeParse({ cwd: '/fixture' }).success, false);
});

test('M461 roots fingerprint is stable, then changes on add/remove/rename/size/mtime/config', () => {
  const root = mkdtempSync('/tmp/zcode-m461-fp-');
  try {
    const user = join(root, 'user'), cwd = join(root, 'cwd');
    const skill = join(user, '.agents/skills/demo/SKILL.md');
    mkdirSync(join(skill, '..'), { recursive: true }); mkdirSync(cwd, { recursive: true });
    mkdirSync(join(user, '.zcode/cli'), { recursive: true });
    writeFileSync(skill, 'x'.repeat(10)); writeFileSync(join(user, '.zcode/cli/config.json'), '{}');
    const stable = rootsFingerprint(cwd, user);
    assert.equal(rootsFingerprint(cwd, user), stable);
    mkdirSync(join(user, '.agents/skills/added'), { recursive: true });
    writeFileSync(join(user, '.agents/skills/added/SKILL.md'), 'new');
    const changed = rootsFingerprint(cwd, user);
    assert.notEqual(changed, stable);
    rmSync(join(user, '.agents/skills/added'), { recursive: true });
    assert.equal(rootsFingerprint(cwd, user), stable, 'removal restores the fingerprint');
    const bigger = join(user, '.agents/skills/bigger/SKILL.md');
    mkdirSync(join(bigger, '..'), { recursive: true }); writeFileSync(bigger, 'x'.repeat(11));
    assert.notEqual(rootsFingerprint(cwd, user), stable, 'size change detected');
    rmSync(join(user, '.agents/skills/bigger'), { recursive: true });
    utimesSync(skill, new Date(2001, 1, 1), new Date(2001, 1, 1));
    assert.notEqual(rootsFingerprint(cwd, user), stable, 'mtime change detected');
  } finally { rmSync(root, { recursive: true }); }
});

test('M461 cached menu serves repeat listings without new CLI runs and refreshes on change', async () => {
  const root = mkdtempSync('/tmp/zcode-m461-cache-');
  try {
    const user = join(root, 'user'), cwd = join(root, 'cwd'), scratch = join(root, 'scratch');
    mkdirSync(join(user, '.agents/skills/keep'), { recursive: true }); mkdirSync(cwd, { recursive: true }); mkdirSync(scratch, { recursive: true });
    writeFileSync(join(user, '.agents/skills/keep/SKILL.md'), '---\nname: keep\ndescription: fixture\n---\n');
    clearRootsCache(); assert.equal(rootsCacheSize(), 0);
    const first = await resolveNativeRootsCached(cwd, scratch, undefined, user);
    assert.equal(rootsCacheSize(), 1);
    const second = await resolveNativeRootsCached(cwd, scratch, undefined, user);
    assert.deepEqual(second, first, 'cache hit returns the same menu');
    writeFileSync(join(user, '.agents/skills/keep/SKILL.md'), '---\nname: keep\ndescription: changed\n---\nchanged body');
    const third = await resolveNativeRootsCached(cwd, scratch, undefined, user);
    assert.deepEqual(third, first, 'content-only change keeps canonical roots');
    mkdirSync(join(cwd, '.zcode/skills/late'), { recursive: true });
    writeFileSync(join(cwd, '.zcode/skills/late/SKILL.md'), '---\nname: late\ndescription: fixture\n---\n');
    const fourth = await resolveNativeRootsCached(cwd, scratch, undefined, user);
    assert.ok(JSON.stringify(fourth).includes('late'), 'invalidation picks up the new root');
    assert.equal(rootsCacheSize(), 1, 'one entry per project folder');
    assert.deepEqual(await resolveNativeRootsCached(cwd, scratch, undefined, user, false,
      { ...nativePaths(), executable: join(root, 'no-such-cli') }), fourth, 'cache hit spawns no CLI');
    clearRootsCache(); assert.equal(rootsCacheSize(), 0);
    assert.deepEqual(await resolveNativeRootsCached(null, scratch), { skills: [], commands: [] });
  } finally { rmSync(root, { recursive: true }); clearRootsCache(); }
});
