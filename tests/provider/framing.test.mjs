import test from 'node:test';
import assert from 'node:assert/strict';
import { api, frame, rows, wires, complete } from './helpers.mjs';

test('incremental protocol lines, UTF-8 split, limits and EOF', () => {
  const line = Buffer.from(JSON.stringify({ text: '\u0442\u0435\u043a\u0441\u0442' }) + '\n');
  const decoder = new api.JsonLineDecoder(64);
  assert.deepEqual(decoder.feed(line.subarray(0, 12)), []);
  assert.deepEqual(decoder.feed(line.subarray(12)), [{ text: '\u0442\u0435\u043a\u0441\u0442' }]); decoder.end();
  assert.deepEqual(decoder.feed(Buffer.from('BAD\n')), []);
  assert.throws(() => decoder.feed(Buffer.from('{BAD\n')), /malformed/);
  assert.throws(() => decoder.feed(Buffer.from([0xff, 10])), /malformed/);
  assert.throws(() => decoder.feed(Buffer.alloc(65)), /line-too-large/);
  decoder.feed(Buffer.from('{')); assert.throws(() => decoder.end(), /truncated/);
  assert.deepEqual(new api.JsonLineDecoder(2).feed(Buffer.from('{}\n{}\n')), [{}, {}]);
});
test('out of order fragments, duplicate and complete framing; CRC reference vector', () => {
  assert.equal(api.crc32(Buffer.from('123456789')), 'cbf43926');
  const f = frame(api.parseSnapshot({ logEpoch: 'epoch1', rows: { window: rows(), totalCount: 3, firstRowId: 1 } }, () => {}));
  const ws = wires(f, 3), decoder = new api.FrameDecoder(() => {});
  assert.equal(decoder.ingest(ws[2], 0), null);
  assert.equal(decoder.ingest(ws[2], 1), null);
  assert.equal(decoder.ingest(ws[0], 2), null);
  assert.deepEqual(decoder.ingest(ws[1], 3), f); assert.equal(decoder.pending, 0);
  assert.deepEqual(decoder.ingest(complete(f), 4), f);
});
test('bad CRC/base64/UTF-8/JSON/metadata/ownership and bounded memory are errors', () => {
  const f = frame(), ws = wires(f, 1);
  const check = (w, pattern) => assert.throws(() => new api.FrameDecoder(() => {}).ingest(w, 0), pattern);
  check({ ...ws[0], checksum: { algorithm: 'crc32', value: '00000000' } }, /checksum-mismatch/);
  check({ ...ws[0], dataBase64: '!!!!' }, /invalid-base64/);
  check({ ...ws[0], fragmentIndex: 1 }, /fragment-bounds/);
  check({ ...complete(f), topic: 'other' }, /ownership/);
  check({ ...complete(f), wireVersion: 999 }, /unsupported/);
  for (const bytes of [Buffer.from([0xff]), Buffer.from('{')]) {
    check({ ...ws[0], logicalBytes: bytes.length, dataBase64: bytes.toString('base64'), checksum: { algorithm: 'crc32', value: api.crc32(bytes) } }, /json-or-utf8/);
  }
  const d = new api.FrameDecoder(() => {}, { maxAssemblies: 1 });
  const two = wires(f);
  d.ingest(two[0], 0);
  assert.throws(() => d.ingest({ ...two[0], logicalFrameId: 'other' }, 1), /too-many/);
  assert.throws(() => d.ingest({ ...two[1], logicalFrameOrdinal: 2 }, 2), /metadata/);
  assert.equal(d.pending, 0);
  d.ingest(two[0], 0);
  const changed = { ...two[0], dataBase64: Buffer.from('x').toString('base64') };
  assert.throws(() => d.ingest(changed, 1), /fragment-conflict/); assert.equal(d.pending, 0);
  assert.throws(() => new api.FrameDecoder(() => {}, { maxBytes: 2 }).ingest(complete(f)), /too-large/);
  assert.throws(() => new api.FrameDecoder(() => {}, { maxBytes: 0 }), /invalid-decoder-limit/);
});
test('assembly expiry clears staging, generation owner clears explicitly', () => {
  const d = new api.FrameDecoder(() => {}, { timeoutMs: 10 });
  d.ingest(wires(frame())[0], 0);
  d.expire(10); assert.equal(d.pending, 0);
  d.ingest(wires(frame())[0], 11); d.clear(); assert.equal(d.pending, 0);
});
test('protocol JSON and warnings use separate sinks, never include raw payload', () => {
  const stdout = [], stderr = [];
  const warn = api.stderrWarnings(line => stderr.push(line));
  const f = frame(); f.payload.snapshot.rows.window.push({ rowId: 7, kind: 'future', secret: 'fixture-sensitive' });
  new api.FrameDecoder(warn).ingest(complete(f));
  stdout.push(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n');
  assert.equal(stderr.length, 1); assert.match(stderr[0], /unknown-row-kind/);
  assert.ok(!stderr[0].includes('fixture-sensitive'));
  assert.deepEqual(new api.JsonLineDecoder().feed(Buffer.from(stdout.join(''))), [{ jsonrpc: '2.0', id: 1, result: {} }]);
});
