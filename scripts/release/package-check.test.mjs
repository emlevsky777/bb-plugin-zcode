// Run against the exported tree. TypeScript is a declared development dependency
// used by the bb-retry fixture to inspect actual shipped source; no blanket allow.
import { experimental_scanPublicSdkOnly as scan } from '@get-bb/plugin-sdk/testing';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const root = resolve(process.argv[2] ?? '.');
const result = scan(root, { allow: [/^typescript$/] });
assert.deepEqual(result.violations, []); assert.deepEqual(result.privateDependencies, []);
assert.ok(result.files.includes('scripts/provider/build.mjs'));
assert.ok(result.files.includes('tests/provider/report-cli.test.mjs'));
assert.ok(existsSync(join(root, 'skills/zcode-provider/SKILL.md')));
const registry = JSON.parse(readFileSync(join(root, 'compat/touchpoints.json'), 'utf8'));
for (const point of registry.touchpoints ?? registry.points) for (const path of [...point.code, ...point.sources])
  assert.ok(existsSync(join(root, path)), 'unresolved registry path: ' + path);
const temp = mkdtempSync(join(tmpdir(), 'sdk-mjs-'));
try {
  writeFileSync(join(temp, 'package.json'), '{}');
  writeFileSync(join(temp, 'forbidden.mjs'), "import '@bb/domain';\n");
  const negative = scan(temp);
  assert.ok(negative.files.includes('forbidden.mjs'));
  assert.ok(negative.violations.some(v => v.file === 'forbidden.mjs' && v.reason === 'private-package'));
} finally { rmSync(temp, { recursive: true }); }
const markdown = [];
function walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(ent.name)) continue;
    const path = join(dir, ent.name);
    assert.ok(!['.local', 'traces', 'recordings'].includes(ent.name), 'private tree: ' + path);
    if (ent.isDirectory()) walk(path);
    else if (ent.name.endsWith('.md')) markdown.push(path);
  }
}
walk(root);
for (const path of markdown) {
  for (const [, target] of readFileSync(path, 'utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^https:\/\//.test(target) || target.startsWith('#')) continue;
    assert.ok(!/^\w+:/.test(target), 'unsupported link: ' + target);
    assert.ok(existsSync(resolve(dirname(path), target.split('#')[0])), 'broken link in ' + path + ': ' + target);
  }
}
const overview = readFileSync(join(root, 'PLUGIN_OVERVIEW.md'), 'utf8');
assert.ok([...overview].length <= 4000);
for (const [, target] of overview.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) assert.match(target, /^https:\/\//);
console.log(JSON.stringify({ files: result.files.length, violations: result.violations,
  privateDependencies: result.privateDependencies, mjsCoverage: true, negativeMjsRejected: true,
  markdownFiles: markdown.length, overviewCharacters: [...overview].length }));
