import test from 'node:test';
import assert from 'node:assert/strict';
import { api, rows, snapshot, inputs } from './helpers.mjs';
// Native-shaped fields: pinned29628c9 packages/shared/src/zcode-protocol-v4/rows.ts
// userInput100-150, timelineMarker330-418; no invented assistant/tool state.
const service = [
  { rowId: 10, kind: 'userInput', turnId: 'turn1', createdAt: 100, createdAtSeq: 1, text: 'synthetic', origin: 'realUser', future: { preserved: true } },
  { rowId: 11, kind: 'timelineMarker', turnId: 'turn1', createdAt: 101, createdAtSeq: 2, lane: 'lightBoundary', marker: { type: 'modelChange', fromProvider: 'synthetic', fromModel: 'before', toProvider: 'synthetic', toModel: 'after', toThought: 'high' } },
];
test('known native service rows preserved without kind warning, projection and turn/items closure unchanged', () => {
  const warnings = [], warn = d => warnings.push(d.code);
  for (const row of service) assert.deepEqual(api.parseRow(row, warn), row);
  assert.deepEqual(warnings, []);
  const before = rows(), after = [...before, ...service];
  const project = rs => {
    const diagnostics = [];
    const sink = d => diagnostics.push(d.code);
    return { deltas: new api.EventTranslator('session1', 'epoch1', 1, sink).project(api.parseSnapshot(snapshot(rs), sink), 1, inputs(rs)), diagnostics };
  };
  assert.deepEqual(project(after), project(before)); assert.deepEqual(warnings, []);
});
test('unknown kinds and service enums remain visible; invalid base/text/marker fields rejected', () => {
  const warnings = [], warn = d => warnings.push(d.code);
  const unknown = { rowId: 20, kind: 'future', future: { raw: true } };
  assert.deepEqual(api.parseRow(unknown, warn), unknown);
  for (const row of [{ ...service[0], origin: 'future' }, { ...service[1], lane: 'future' }, { ...service[1], marker: { type: 'future', payload: { kept: true } } }]) assert.deepEqual(api.parseRow(row, warn), row);
  assert.deepEqual(warnings, ['unknown-row-kind', 'unknown-row-enum', 'unknown-row-enum', 'unknown-row-enum']);
  for (const row of [{ ...service[0], rowId: -1 }, { ...service[1], turnId: 4 }, { ...service[0], text: null }, { ...service[1], marker: null }]) assert.throws(() => api.parseRow(row, warn));
});
