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
// GitHub-style anchors for ATX headings (#..######, optional closing hashes):
// link/image markup collapses to its label, emphasis and code markers drop out
// as punctuation, Unicode letters/digits survive, text is lowercased, whitespace
// runs become hyphens, repeated headings get -1/-2 suffixes. Headings inside
// fenced code blocks are ignored.
function slug(text) {
  return text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
}
function headingSlugs(text) {
  const slugs = new Set();
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (fence.char === marker[1][0] && marker[1].length >= fence.length &&
        /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^ {0,3}(#{1,6})(?!#)(?:[ \t]+(.*?))?[ \t]*#*$/);
    if (!heading) continue;
    const base = slug(heading[2] ?? '');
    let anchor = base;
    for (let n = 1; slugs.has(anchor); n++) anchor = base + '-' + n;
    slugs.add(anchor);
  }
  return slugs;
}
// Same-document (#frag) and cross-document (path.md#frag) fragments must resolve
// to a heading anchor of the target Markdown file, percent-encoded fragments are
// decoded first; fragments of non-Markdown targets stay out of scope.
function checkLinks(path, text, docs) {
  for (const [, target] of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    if (/^https:\/\//.test(target)) continue;
    assert.ok(!/^\w+:/.test(target), 'unsupported link: ' + target);
    const hash = target.indexOf('#');
    const filePart = hash === -1 ? target : target.slice(0, hash);
    assert.ok(existsSync(resolve(dirname(path), filePart)), 'broken link in ' + path + ': ' + target);
    const fragment = hash === -1 ? '' : target.slice(hash + 1);
    if (!fragment) continue;
    const doc = docs.get(hash === 0 ? path : resolve(dirname(path), filePart));
    if (!doc) continue;
    let decoded = fragment;
    try { decoded = decodeURIComponent(fragment); } catch { /* keep raw */ }
    assert.ok(doc.slugs.has(decoded), 'broken fragment in ' + path + ': ' + target);
  }
}
const docs = new Map(markdown.map(path => {
  const text = readFileSync(path, 'utf8');
  return [path, { text, slugs: headingSlugs(text) }];
}));
for (const [path, doc] of docs) checkLinks(path, doc.text, docs);
// Regression fixtures for the fragment rules above.
const fixture = mkdtempSync(join(tmpdir(), 'sdk-frag-'));
try {
  const otherText = '# Remote target\n\n## Section\n';
  writeFileSync(join(fixture, 'other.md'), otherText);
  writeFileSync(join(fixture, 'data.json'), '{}\n');
  const pagePath = join(fixture, 'page.md');
  const pageText = ['# Title', '', '````md', '# Not a heading', '```', '# Still fenced', '````', '', '## Café ##', '',
    '## Repeat', '## Repeat', '## Repeat', '', '## **Bold**, `code` and [a link](https://example.com/x)!', '',
    'Same doc: [1](#title), [2](#café), [3](#caf%C3%A9), [4](#repeat-2),',
    '[5](#bold-code-and-a-link), cross doc: [6](other.md#remote-target), [7](other.md#section),',
    'non-Markdown: [8](data.json#ignored).', ''].join('\n');
  const fixtureDocs = new Map([[pagePath, { text: pageText, slugs: headingSlugs(pageText) }],
    [join(fixture, 'other.md'), { text: otherText, slugs: headingSlugs(otherText) }]]);
  checkLinks(pagePath, pageText, fixtureDocs);
  const sevenHashes = '#######\n#######\n[broken](#-1)\n';
  assert.throws(() => checkLinks(pagePath, sevenHashes, new Map([[pagePath, { text: sevenHashes, slugs: headingSlugs(sevenHashes) }]])), /broken fragment/);
  for (const bad of ['#no-such-heading', 'other.md#no-such-heading', '#caf%C3%A8', '#Title', '#t.i.t.l.e', '#still-fenced'])
    assert.throws(() => checkLinks(pagePath, pageText.replace('[1](#title)', `[1](${bad})`), fixtureDocs),
      /broken fragment/);
} finally { rmSync(fixture, { recursive: true }); }
const overview = readFileSync(join(root, 'PLUGIN_OVERVIEW.md'), 'utf8');
assert.ok([...overview].length <= 4000);
const hook = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).bb.description;
assert.ok([...hook].length <= 140);
assert.match(overview, /^## /);
assert.ok(!overview.includes(hook), 'overview repeats lead');
assert.ok(!/^#{1,6} /m.test(overview.replace(/^## .*$/gm, '')), 'sections must use ##');
assert.ok(!/<\/?[A-Za-z][^>]*>|!\[|^\s*\||\[\^|^\s*[-*] \[[ xX]\]/m.test(overview), 'unsupported listing markup');
for (const [, target] of overview.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) assert.match(target, /^https:\/\//);
console.log(JSON.stringify({ files: result.files.length, violations: result.violations,
  privateDependencies: result.privateDependencies, mjsCoverage: true, negativeMjsRejected: true,
  markdownFiles: markdown.length,
  markdownHeadings: [...docs.values()].reduce((sum, doc) => sum + doc.slugs.size, 0),
  fragmentRegression: true, overviewCharacters: [...overview].length }));
