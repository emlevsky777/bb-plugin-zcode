import { createHash } from 'node:crypto';

export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'ProtocolError'; this.code = code; }
}
export interface Diagnostic { code: string }
export type Warn = (diagnostic: Diagnostic, identity?: unknown) => void;
// Entity/value hashes remain local; only fixed codes reach the sink.
export function boundedWarnings(sink: Warn, limit = 4096) {
  const seen = new Set<string>();
  const warn = (diagnostic: Diagnostic, identity: unknown = diagnostic.code): void => {
    const key = createHash('sha256').update(JSON.stringify([diagnostic.code, identity])).digest('hex');
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > limit) seen.delete(seen.values().next().value!);
    sink({ code: diagnostic.code });
  };
  warn.clear = (): void => { seen.clear(); };
  return warn;
}
// Only fixed codes leave this boundary; never raw native payload or user text.
export function stderrWarnings(write: (line: string) => void): Warn {
  return ({ code }) => write(JSON.stringify({ component: 'zcode', warning: code }) + '\n');
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProtocolError('invalid-object');
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new ProtocolError('invalid-string');
  return value;
}
export function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ProtocolError('invalid-integer');
  return value as number;
}
