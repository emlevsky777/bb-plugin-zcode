import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { artifact } from './helpers.mjs';
import { validateRegistry, inspectCompatibility, bundleReader } from '../../scripts/provider/compat-level0.mjs';
const temp = () => mkdtempSync(join(tmpdir(), 'm496b-'));
let rawWrite = writeFileSync;
try { rawWrite = createRequire(import.meta.url)('original-fs').writeFileSync; } catch { /* Ordinary Node. */ }
const registry = JSON.parse(readFileSync(new URL('../../compat/touchpoints.json', import.meta.url), 'utf8'));

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

test('M54 moved anchors accept either observed location and reject missing semantics in both', () => {
  const read = bundleReader('/Applications/ZCode.app');
  for (const point of registry.touchpoints.filter(p => ['zcode-memory-preference', 'zcode-oauth-project-token'].includes(p.id))) {
    const anchor = point.anchors.find(a => a.alternativeFiles);
    const subset = { version: 1, touchpoints: [{ ...point, anchors: [anchor] }] };
    const installed = [anchor.file, ...anchor.alternativeFiles].find(file => {
      try { return read(file).includes(anchor.text); } catch { return false; }
    });
    assert.ok(installed);
    const bytes = read(installed);
    for (const file of [anchor.file, ...anchor.alternativeFiles]) {
      const root = temp();
      try {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), bytes, 'latin1');
        const result = inspectCompatibility(subset, { zcode: root });
        assert.equal(result.summary.notFound, 0);
        assert.equal(result.points[0].anchors[0].matchedFile, file);
        writeFileSync(join(root, file), bytes.replaceAll(anchor.text, 'BROKEN_M54_ANCHOR'), 'latin1');
        assert.equal(inspectCompatibility(subset, { zcode: root }).summary.notFound, 1);
      } finally { rmSync(root, { recursive: true }); }
    }
    for (const alternativeFiles of [[], ['../escape'], [anchor.file], [anchor.alternativeFiles[0], anchor.alternativeFiles[0]]]) {
      const invalid = structuredClone(subset); invalid.touchpoints[0].anchors[0].alternativeFiles = alternativeFiles;
      assert.throws(() => validateRegistry(invalid), /alternative files/);
    }
  }
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
