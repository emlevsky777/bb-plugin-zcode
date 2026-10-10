import { ProtocolError, record, string, integer } from './errors.ts';
import type { Warn } from './errors.ts';
import { crc32 } from './crc32.ts';
import { parseFrame } from './native.ts';
import type { Frame } from './native.ts';

// Independent bounded Node implementation of the pinned V4 wire format.
export interface DecoderLimits { maxBytes: number; maxFragments: number; maxAssemblies: number; timeoutMs: number }
const defaults: DecoderLimits = { maxBytes: 16 * 1024 * 1024, maxFragments: 1024, maxAssemblies: 16, timeoutMs: 10_000 };
type Assembly = { metadata: string; parts: Map<number, Buffer>; size: number; started: number };
export class FrameDecoder {
  private assemblies = new Map<string, Assembly>();
  readonly limits: DecoderLimits;
  private warn: Warn;
  constructor(warn: Warn, limits: Partial<DecoderLimits> = {}) {
    this.warn = warn; this.limits = { ...defaults, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > defaults[key as keyof DecoderLimits]) throw new ProtocolError('invalid-decoder-limit');
    }
  }
  get pending(): number { return this.assemblies.size; }
  clear(): void { this.assemblies.clear(); }
  expire(now: number): void {
    let expired = false;
    for (const [key, a] of this.assemblies) if (now - a.started >= this.limits.timeoutMs) { this.assemblies.delete(key); expired = true; }
    if (expired) this.warn({ code: 'assembly-timeout' });
  }
  ingest(value: unknown, now = Date.now()): Frame | null {
    this.expire(now);
    const w = record(value);
    if (w.wireVersion !== 3) throw new ProtocolError('unsupported-wire-version');
    const topic = string(w.topic), subscriptionId = string(w.subscriptionId), id = string(w.logicalFrameId);
    integer(w.logicalFrameOrdinal);
    const key = JSON.stringify([topic, subscriptionId, id]);
    try {
      let raw: unknown;
      if (w.kind === 'complete') {
        if (Buffer.byteLength(JSON.stringify(w.frame)) > this.limits.maxBytes) throw new ProtocolError('assembly-too-large');
        if (this.assemblies.has(key)) throw new ProtocolError('fragment-metadata-mismatch');
        raw = w.frame;
      } else if (w.kind === 'fragment') {
        const count = integer(w.fragmentCount), index = integer(w.fragmentIndex), bytes = integer(w.logicalBytes), checksum = record(w.checksum);
        if (!count || !bytes || count > this.limits.maxFragments || count > bytes || index >= count || bytes > this.limits.maxBytes) throw new ProtocolError('fragment-bounds');
        if (checksum.algorithm !== 'crc32' || !/^[0-9a-f]{8}$/.test(string(checksum.value))) throw new ProtocolError('invalid-checksum');
        const b64 = string(w.dataBase64);
        if (b64.length > 4 * Math.ceil(bytes / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) throw new ProtocolError('invalid-base64');
        const part = Buffer.from(b64, 'base64');
        if (part.toString('base64') !== b64) throw new ProtocolError('noncanonical-base64');
        const metadata = JSON.stringify([count, bytes, checksum.value, w.logicalFrameOrdinal, w.deliveryKind]);
        let a = this.assemblies.get(key);
        if (!a) {
          if (this.pending >= this.limits.maxAssemblies) throw new ProtocolError('too-many-assemblies');
          a = { metadata, parts: new Map(), size: 0, started: now }; this.assemblies.set(key, a);
        }
        if (a.metadata !== metadata) throw new ProtocolError('fragment-metadata-mismatch');
        const previous = a.parts.get(index);
        if (previous && !previous.equals(part)) throw new ProtocolError('fragment-conflict');
        if (!previous) { a.parts.set(index, part); a.size += part.length; }
        if (a.size > bytes) throw new ProtocolError('fragment-overflow');
        if (a.parts.size !== count) return null;
        this.assemblies.delete(key);
        const joined = Buffer.concat(Array.from({ length: count }, (_, i) => a.parts.get(i)!));
        if (joined.length !== bytes || crc32(joined) !== checksum.value) throw new ProtocolError('checksum-mismatch');
        try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)); }
        catch { throw new ProtocolError('invalid-frame-json-or-utf8'); }
      } else throw new ProtocolError('unknown-wire-kind');
      const f = parseFrame(raw, this.warn);
      if (f.topic !== topic || f.subscriptionId !== subscriptionId) throw new ProtocolError('frame-ownership-mismatch');
      return f;
    } catch (e) { this.assemblies.delete(key); throw e; }
  }
}

// Strict recovery policy: non-JSON stdout, bad UTF-8 and truncated framing abort the batch.
// Fixed ProtocolError codes carry no raw stdout/secret payload. Caller must resnapshot;
// JSON objects/RPC errors are returned intact for the correlation layer, never discarded.
export class JsonLineDecoder {
  private buffered = Buffer.alloc(0);
  private maxBytes: number;
  constructor(maxBytes = 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024) throw new ProtocolError('invalid-line-limit');
    this.maxBytes = maxBytes;
  }
  feed(chunk: Uint8Array): unknown[] {
    const result: unknown[] = [];
    // Consume per line before allocation; a chunk containing many small lines is valid.
    const input = Buffer.from(chunk);
    let start = 0;
    try {
      for (let i = 0; i < input.length; i++) if (input[i] === 10) {
        if (this.buffered.length + i - start > this.maxBytes) throw new ProtocolError('line-too-large');
        const bytes = Buffer.concat([this.buffered, input.subarray(start, i)]);
        this.buffered = Buffer.alloc(0); start = i + 1;
        try { result.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
        catch { throw new ProtocolError('malformed-protocol-line'); }
      }
      if (this.buffered.length + input.length - start > this.maxBytes) throw new ProtocolError('line-too-large');
      this.buffered = Buffer.concat([this.buffered, input.subarray(start)]);
      return result;
    } catch (e) { this.buffered = Buffer.alloc(0); throw e; }
  }
  end(): void {
    const partial = this.buffered.length > 0; this.buffered = Buffer.alloc(0);
    if (partial) throw new ProtocolError('truncated-protocol-line');
  }
}
