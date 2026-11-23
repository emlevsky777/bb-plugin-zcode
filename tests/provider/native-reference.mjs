import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import ts from 'typescript';

// Development-only source oracle. Execute selected functions in fixtures,
// never the native entrypoint. Pin the reviewed target before parsing it.
export function nativeReference() {
  const source = readFileSync('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs', 'utf8');
  assert.equal(createHash('sha256').update(source).digest('hex'), '0de95ddd65d7712a3beeccc8ee6de53ea0ce96338eb427e52b2717ba2f3afe19');
  const ast = ts.createSourceFile('native.js', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const functions = new Map();
  function visit(n) {
    if (ts.isFunctionDeclaration(n) && n.name) functions.set(n.name.text, source.slice(n.getStart(ast), n.end));
    ts.forEachChild(n, visit);
  }
  visit(ast);
  return {source, fn(name) { assert.ok(functions.has(name), name); return functions.get(name); }};
}
