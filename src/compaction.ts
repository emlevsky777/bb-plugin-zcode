import { record } from './errors.ts';
import type { Snapshot } from './native.ts';

type Pending = { clientRequestId: string; accepted: boolean; closed: boolean };
export const compactionItemSchema = { '~standard': { version: 1 as const, vendor: 'zcode', validate(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && Object.keys(value)[0] === 'outcome' &&
      typeof record(value).outcome === 'string' && ['pending', 'success', 'noop', 'completed', 'failed', 'interrupted'].includes(record(value).outcome as string)) return { value };
  return { issues: [{ message: 'Invalid compaction outcome' }] };
} } };
const item = (kind: string, outcome: string) => ({ type: 'extension', kind, payload: { outcome } });
const presentation = (title: string) => ({ label: { pending: 'Compacting context', completed: title }, icon: { glyph: 'Minimize2' }, title });
// Bookkeeping only. Delivery, queueing and the compact lock belong to ZCode.
export class CompactionProjection {
  private requests = new Map<string, Pending>();
  private emit: (deltas: Record<string, unknown>[]) => void;
  private kind: string;
  constructor(emit: (deltas: Record<string, unknown>[]) => void, kind = 'zcode/compaction') { this.emit = emit; this.kind = kind; }
  begin(id: string, clientRequestId: string): void {
    if (this.requests.has(id) || [...this.requests.values()].some(p => p.clientRequestId === clientRequestId)) throw Error('Duplicate compact request');
    this.requests.set(id, { clientRequestId, accepted: false, closed: false });
  }
  reject(id: string): void { this.requests.delete(id); }
  owns(id: unknown): boolean { return typeof id === 'string' && this.requests.has(id); }
  accept(id: string): void {
    const p = this.requests.get(id);
    if (!p || p.accepted) return;
    p.accepted = true;
    const providerTurnId = 'zcode-compact:' + id;
    this.emit([{ kind: 'turn.open', providerTurnId }, { kind: 'input.accepted', clientRequestId: p.clientRequestId, providerTurnId },
      { kind: 'item.open', providerTurnId, key: { providerItemId: providerTurnId }, item: item(this.kind, 'pending'), presentation: presentation('Compacting context') }]);
  }
  project(snapshot: Snapshot): void {
    for (const row of snapshot.rows.window) {
      if (row.kind !== 'timelineMarker' || typeof row.sourceCommandId !== 'string') continue;
      const marker = record(row.marker), p = this.requests.get(row.sourceCommandId);
      if (marker.type !== 'compact' || marker.origin !== 'manual' || !p?.accepted || p.closed) continue;
      const status = marker.status;
      if (!['success', 'noop', 'failed', 'cancelled'].includes(String(status))) continue;
      this.finish(row.sourceCommandId, status === 'cancelled' ? 'interrupted' : status === 'failed' ? 'failed' : 'completed', status === 'success',
        status === 'noop' ? 'ZCode skipped compaction: context did not need compression.' : status === 'failed' ? 'ZCode compaction failed.' : status === 'cancelled' ? 'ZCode compaction was cancelled.' : undefined);
    }
  }
  settle(status: 'failed' | 'interrupted'): void {
    for (const [id, p] of this.requests) if (p.accepted && !p.closed) this.finish(id, status, false,
      status === 'interrupted' ? 'Compaction stopped; native completion was not confirmed.' : 'Compaction outcome is unknown after native process failure. Reconcile before retry.');
  }
  private finish(id: string, status: string, compacted: boolean, summary?: string): void {
    const p = this.requests.get(id)!; p.closed = true;
    const providerTurnId = 'zcode-compact:' + id;
    const title = compacted ? 'Context compacted' : status === 'completed' ? 'Compaction skipped' : status === 'failed' ? 'Compaction failed' : 'Compaction stopped';
    const deltas: Record<string, unknown>[] = [{ kind: 'item.close', providerTurnId, key: { providerItemId: providerTurnId },
      item: item(this.kind, compacted ? 'success' : status === 'completed' ? 'noop' : status), presentation: presentation(title), status,
      ...(summary ? { resultText: summary } : {}) }];
    if (compacted) deltas.push({ kind: 'context.compacted', providerTurnId });
    if (summary) deltas.push({ kind: 'provider.warning', category: status === 'completed' ? 'compaction-skipped' : 'general', summary });
    deltas.push({ kind: 'turn.boundary', providerTurnId, status });
    this.emit(deltas);
  }
}
