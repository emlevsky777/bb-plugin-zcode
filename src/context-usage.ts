import type { ThreadDelta } from '@get-bb/plugin-sdk/provider-bridge';
import type { Frame, Snapshot } from './native.ts';

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

// Native owns accounting and model capacity. This projects its last known
// context, not cumulative usage or a locally tokenized approximation.
export class ContextUsageProjection {
  private last: string | undefined;
  private initialized = false;
  private compactStatuses = new Map<number, unknown>();
  private awaitingUsage = false;
  private cumulative: (number | null)[] | undefined;
  private emit: (delta: ThreadDelta) => void;
  constructor(emit: (delta: ThreadDelta) => void) { this.emit = emit; }

  reset(): void { this.publish(null, null); }

  project(snapshot: Snapshot, payload?: Frame['payload']): void {
    const window = object(object(snapshot.usage).contextWindow);
    let used = count(window.usedTokens);
    const capacity = count(window.maxTokens);
    const size = capacity !== null && capacity > 0 ? capacity : null;
    const successes = new Set<number>();
    let lastCompact: Record<string, unknown> | undefined;
    for (const row of snapshot.rows.window) {
      if (row.kind !== 'timelineMarker') continue;
      const marker = object(row.marker);
      if (marker.type !== 'compact') continue;
      if (marker.status === 'success') {
        lastCompact = marker;
        if (this.compactStatuses.get(row.rowId) !== 'success') successes.add(row.rowId);
      }
      this.compactStatuses.set(row.rowId, marker.status);
    }
    if (!this.initialized) {
      // The native cold seed can itself be the messages-only compact count.
      this.awaitingUsage = lastCompact !== undefined &&
        (count(lastCompact.tokensAfter) === null || used === count(lastCompact.tokensAfter));
      this.observeUsage(snapshot.usage);
    } else if (payload?.kind === 'deltas') {
      // Preserve ordering when a frame batches main accounting with compaction.
      for (const delta of payload.deltas) {
        if (delta.op === 'row.appended' || delta.op === 'row.upserted') {
          const row = object(delta.row), marker = object(row.marker);
          if (marker.status === 'success' && successes.delete(row.rowId as number)) this.awaitingUsage = true;
        } else if (delta.op === 'state.updated' && Object.hasOwn(object(delta.patch), 'usage')) {
          if (this.observeUsage(object(delta.patch).usage)) this.awaitingUsage = false;
        }
      }
      if (successes.size) this.awaitingUsage = true;
    } else {
      const mainUpdated = this.observeUsage(snapshot.usage);
      if (successes.size) this.awaitingUsage = true;
      else if (mainUpdated) this.awaitingUsage = false;
    }
    this.initialized = true;
    // V4 uses zero for missing main-response usage; an existing context is not empty.
    if (this.awaitingUsage || used === 0 && snapshot.rows.totalCount > 0) used = null;
    this.publish(used, size);
  }

  private observeUsage(usage: unknown): boolean {
    const raw = object(object(usage).cumulative);
    const next = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(key => count(raw[key]));
    // Only main accounting advances these native counters. They establish
    // provenance, never the displayed context value. Missing data stays unknown.
    const advanced = next.some((value, i) => value !== null && this.cumulative?.[i] !== null &&
      this.cumulative?.[i] !== undefined && value > this.cumulative[i]!);
    this.cumulative = next;
    return advanced;
  }

  private publish(used: number | null, size: number | null): void {
    const signature = JSON.stringify([used, size]);
    if (this.last === signature) return;
    this.last = signature;
    this.emit({ kind: 'contextWindow', used, size, estimated: true, attach: 'currentOrLast' });
  }
}
