import { readFileSync } from 'node:fs';
import '../../scripts/provider/guard.mjs';
export const artifact = process.env.ZCODE_TEST_ARTIFACT === '1';
export const api = await (artifact ? import('../../dist/index.js') : import('../../src/index.ts'));
export const host = await (artifact ? import('../../dist/host.js') : import('../../src/host.ts'));
export const plugin = (await (artifact ? import('../../dist/plugin.js') : import('../../src/plugin.ts'))).default;
export const accepted = JSON.parse(readFileSync(new URL('./fixtures/accepted-write.json', import.meta.url), 'utf8')).frame;
export function snapshot(rows = [], epoch = 'epoch1') {
  return { logEpoch: epoch, rows: { window: structuredClone(rows), totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null } };
}
export function frame(s = snapshot(), fromSeq = 0, toSeq = 1) {
  return { topic: 'conversation/session1', subscriptionId: 'subscription1', fromSeq, toSeq, payload: { kind: 'snapshot', snapshot: s } };
}
// Explicit authoritative input fixture; product code never infers this from ACK.
export function inputs(rs, generation = 1) {
  const c = new api.CommandCorrelation();
  for (const h of rs.filter(r => r.kind === 'turnHeader')) {
    const id = h.sourceCommandId ?? `fixture-${h.turnId}`;
    c.begin(id, 'creq_2222222222', generation, 100);
    c.authoritative(id, generation, 'inputAccepted', h.turnId);
  }
  return c;
}
export function delta(ds, fromSeq = 1, toSeq = 2) {
  return { ...frame(), fromSeq, toSeq, payload: { kind: 'deltas', deltas: ds } };
}
export function rows(turn = 'turn1', base = 1) {
  return [
    { rowId: base, kind: 'turnHeader', turnId: turn, state: 'completedSuccess', sourceCommandId: `command-${turn}` },
    { rowId: base + 1, kind: 'assistantText', turnId: turn, state: 'complete', text: `text-${turn}` },
    { rowId: base + 2, kind: 'toolCall', turnId: turn, toolName: 'Write', status: 'success', input: { content: 'NATIVE_OK' }, output: { text: 'written' } },
  ];
}
export function wires(f, parts = 2) {
  const bytes = Buffer.from(JSON.stringify(f)), size = Math.ceil(bytes.length / parts);
  return Array.from({ length: parts }, (_, i) => ({ wireVersion: 3, kind: 'fragment', topic: f.topic, subscriptionId: f.subscriptionId,
    logicalFrameId: 'frame1', logicalFrameOrdinal: 1, deliveryKind: 'snapshot', logicalBytes: bytes.length,
    fragmentCount: parts, fragmentIndex: i, checksum: { algorithm: 'crc32', value: api.crc32(bytes) },
    dataBase64: bytes.subarray(i * size, (i + 1) * size).toString('base64') }));
}
export function complete(f) { return { wireVersion: 3, kind: 'complete', topic: f.topic, subscriptionId: f.subscriptionId, logicalFrameId: 'frame1', logicalFrameOrdinal: 1, frame: f }; }
