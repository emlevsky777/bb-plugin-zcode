import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { bundleReader } from '../../scripts/provider/compat-level0.mjs';

test('installed bb retry preserves accepted input and continues; unaccepted input is submitted once with its original groups', () => {
  const read = bundleReader('/Applications/bb.app');
  const map = JSON.parse(read('Contents/Resources/app.asar/node_modules/bb-app/server/dist/start-server.js.map'));
  const index = map.sources.findIndex(p => p.endsWith('/services/threads/turn-retry.ts'));
  assert.ok(index >= 0);
  const source = map.sourcesContent[index];
  const parsed = ts.createSourceFile('turn-retry.ts', source, ts.ScriptTarget.Latest, true);
  const node = parsed.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'retryInput');
  assert.ok(node);
  const js = ts.transpileModule(node.getText(parsed), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  let accepted = false;
  const declaration = parsed.statements.filter(ts.isVariableStatement).flatMap(n => [...n.declarationList.declarations])
    .find(n => n.name.getText(parsed) === 'CONTINUE_ACCEPTED_TURN_TEXT');
  assert.ok(declaration && ts.isStringLiteral(declaration.initializer));
  assert.equal(declaration.initializer.text, 'Please continue.');
  const retry = new Function('wasFailedTurnInputAccepted', 'CONTINUE_ACCEPTED_TURN_TEXT', js + ';return retryInput;')(() => accepted, declaration.initializer.text);
  const text = { type: 'text', text: 'perform controlled effect once', mentions: [] };
  const failed = { request: { input: [text], inputGroups: [[text]] } };
  const copy = structuredClone(failed);
  assert.deepEqual(retry({}, { threadId: 'fixture', failed }), {
    input: [{ ...text, visibility: 'agent-only' }], inputGroups: [[{ ...text, visibility: 'agent-only' }]] });
  accepted = true;
  const continued = retry({}, { threadId: 'fixture', failed });
  assert.equal(continued.input[0].text, 'Please continue.');
  assert.equal(JSON.stringify(continued).includes(text.text), false);
  assert.deepEqual(failed, copy);
});
