// Development-only, read-only release inspection. No CLI/app execution or network.
import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Host Node may be Electron: inspect the physical ASAR, not its virtual fs.
let disk = nodeFs;
try { disk = createRequire(import.meta.url)('original-fs'); } catch { /* Ordinary Node. */ }
const { readFileSync, openSync, readSync, closeSync, statSync } = disk;
const fields = ['id', 'product', 'uses', 'anchors', 'code', 'impact', 'milestones', 'sources'];
const text = v => typeof v === 'string' && v.trim().length > 0;
const safePath = v => text(v) && !v.startsWith('/') && !v.includes('\\') && !v.split('/').some(p => !p || p === '.' || p === '..');
export function validateRegistry(value) {
  const fail = message => { throw Error('Invalid compatibility registry: ' + message); };
  const exact = (v, keys, where) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== [...keys].sort().join()) fail(where + ' fields'); };
  exact(value, ['version', 'touchpoints'], 'root');
  if (value.version !== 1 || !Array.isArray(value.touchpoints) || !value.touchpoints.length) fail('version/touchpoints');
  const ids = new Set(), anchors = new Set();
  for (const p of value.touchpoints) {
    exact(p, fields, p?.id ?? 'point');
    if (!text(p.id) || !/^[a-z][a-z0-9-]+$/.test(p.id) || ids.has(p.id)) fail('duplicate/invalid id'); ids.add(p.id);
    if (!['bb', 'SDK', 'ZCode'].includes(p.product) || !text(p.uses) || !text(p.impact)) fail(p.id + ' product/description');
    for (const name of ['code', 'milestones', 'sources']) if (!Array.isArray(p[name]) || !p[name].length || !p[name].every(text) || new Set(p[name]).size !== p[name].length) fail(p.id + ' ' + name);
    if (!p.code.every(safePath) || !p.sources.every(safePath) || !p.milestones.every(v => /^M\d[\d.a-z]*$/.test(v))) fail(p.id + ' paths/milestones');
    if (!Array.isArray(p.anchors) || !p.anchors.length) fail(p.id + ' anchors');
    for (const a of p.anchors) {
      exact(a, ['file', 'text', 'strength', 'reason', ...(Object.hasOwn(a, 'alternativeFiles') ? ['alternativeFiles'] : [])], p.id + ' anchor');
      if (!safePath(a.file) || !text(a.text) || !['strong', 'weak'].includes(a.strength) || !text(a.reason)) fail(p.id + ' anchor shape');
      if (Object.hasOwn(a, 'alternativeFiles') && (!Array.isArray(a.alternativeFiles) || !a.alternativeFiles.length || !a.alternativeFiles.every(safePath) || new Set([a.file, ...a.alternativeFiles]).size !== a.alternativeFiles.length + 1)) fail(p.id + ' alternative files');
    }
    // Exact duplicates must be represented by one point with merged provenance.
    const key = JSON.stringify([p.product, p.anchors]);
    if (anchors.has(key)) fail(p.id + ' duplicate dependency'); anchors.add(key);
  }
  return value;
}
function readAt(fd, length, position) {
  const result = Buffer.alloc(length); let at = 0;
  while (at < length) { const n = readSync(fd, result, at, length - at, position + at); if (!n) throw Error('Truncated ASAR'); at += n; }
  return result;
}
export function bundleReader(bundle) {
  const cache = new Map(), archives = new Map();
  return file => {
    if (cache.has(file)) return cache.get(file);
    if (!safePath(file)) throw Error('Unsafe bundle path');
    const path = join(resolve(bundle), file); let data;
    const marker = '/app.asar/', index = path.indexOf(marker);
    if (index < 0) data = readFileSync(path);
    else {
      const archive = path.slice(0, index) + '/app.asar', internal = path.slice(index + marker.length);
      if (statSync(archive).isDirectory()) data = readFileSync(path);
      else {
        let info = archives.get(archive);
        if (!info) {
          const fd = openSync(archive, 'r');
          try {
            const prefix = readAt(fd, 16, 0), headerLength = prefix.readUInt32LE(12), headerSize = prefix.readUInt32LE(4);
            if (headerLength > 64 * 1024 * 1024 || headerSize < headerLength + 8 || headerSize > statSync(archive).size - 8) throw Error('Invalid ASAR header');
            info = { header: JSON.parse(readAt(fd, headerLength, 16).toString('utf8')), offset: 8 + headerSize };
            archives.set(archive, info);
          } finally { closeSync(fd); }
        }
        let entry = info.header;
        for (const name of internal.split('/')) entry = entry?.files?.[name];
        if (!entry || entry.files || entry.link) throw Error('Missing or unsupported ASAR entry');
        if (entry.unpacked) data = readFileSync(archive + '.unpacked/' + internal);
        else {
          const offset = Number(entry.offset), size = entry.size;
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0 || size > 256 * 1024 * 1024 || info.offset + offset + size > statSync(archive).size) throw Error('Invalid ASAR entry');
          const fd = openSync(archive, 'r'); try { data = readAt(fd, size, info.offset + offset); } finally { closeSync(fd); }
        }
      }
    }
    // Latin1 preserves ASCII search strings in binary plists as well as text bundles.
    const result = data.toString('latin1'); cache.set(file, result); return result;
  };
}
export function inspectCompatibility(registry, { bb = '/Applications/bb.app', zcode = '/Applications/ZCode.app' } = {}) {
  const start = performance.now(); validateRegistry(registry);
  const readers = { bb: bundleReader(bb), ZCode: bundleReader(zcode) };
  const points = registry.touchpoints.map(p => {
    const anchors = p.anchors.map(a => {
      const attempts = [a.file, ...(a.alternativeFiles ?? [])].map(file => {
        try { return { file, found: readers[p.product === 'SDK' ? 'bb' : p.product](file).includes(a.text), error: null }; }
        catch (e) { return { file, found: false, error: e.code ?? e.message }; }
      });
      const match = attempts.find(attempt => attempt.found), found = !!match;
      return { ...a, found, matchedFile: match?.file ?? null, attempts,
        status: a.strength === 'weak' ? 'weak-anchor' : found ? 'found' : 'not-found', error: found ? null : attempts.find(attempt => attempt.error)?.error ?? null };
    });
    return { id: p.id, product: p.product, uses: p.uses, code: p.code, impact: p.impact, anchors,
      status: anchors.some(a => a.status === 'not-found') ? 'not-found' : anchors.some(a => a.strength === 'weak') ? 'weak-anchor' : 'found' };
  });
  return { level: 0, elapsedMs: Math.round((performance.now() - start) * 100) / 100,
    bundles: { bb: resolve(bb), ZCode: resolve(zcode) },
    summary: { points: points.length, found: points.filter(p => p.status === 'found').length,
      notFound: points.filter(p => p.status === 'not-found').length, weakAnchors: points.flatMap(p => p.anchors).filter(a => a.strength === 'weak').length,
      products: Object.fromEntries(['bb', 'SDK', 'ZCode'].map(k => [k, points.filter(p => p.product === k).length])) },
    affected: points.filter(p => p.status !== 'found').map(p => ({ id: p.id, status: p.status, functions: p.code, impact: p.impact })), points,
    limits: 'Text anchors flag dependencies for review. Presence does not prove behavior, safety, or live compatibility. Weak anchors always require manual review.' };
}
function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { console.log('Usage: node scripts/provider/compat-level0.mjs [--bb /path/bb.app] [--zcode /path/ZCode.app] [--registry path.json]\nRead-only level 0; JSON on stdout; exit 0: all strong anchors found, 1: missing strong anchor, 2: invalid input.'); return; }
    if (!['--bb', '--zcode', '--registry'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('Unknown option or missing value: ' + args[i]);
    options[args[i].slice(2)] = args[++i];
  }
  const registry = JSON.parse(readFileSync(options.registry ?? join(repo, 'compat/touchpoints.json'), 'utf8'));
  const report = inspectCompatibility(registry, options); console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.summary.notFound ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 2; }
}
