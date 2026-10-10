import { ProtocolError, record, string, integer, boundedWarnings } from './errors.ts';
import type { Warn } from './errors.ts';
import { parseFrame, parseRow, parseSnapshot } from './native.ts';
import type { Snapshot } from './native.ts';

export class ConversationState {
  private current: Snapshot | null = null;
  private cursor = -1;
  private generation = -1;
  private topic = '';
  private subscription = '';
  private recovery = false;
  private warn: ReturnType<typeof boundedWarnings>;
  constructor(warn: Warn) { this.warn = boundedWarnings(warn); }
  private diagnostic: Warn = (d, identity) => this.warn(d, [this.generation, identity ?? d.code]);
  get snapshot(): Snapshot | null { return this.current && structuredClone(this.current); }
  get seq(): number { return this.cursor; }
  get requiresSnapshot(): boolean { return this.recovery; }
  // No workflow/background projection exists yet, even for an empty snapshot.
  get workflowProjection(): 'unknown' { return 'unknown'; }
  attach(generation: number, sessionId: string, subscriptionId: string): void {
    if (integer(generation) <= this.generation) throw new ProtocolError('generation-not-increasing');
    this.generation = generation; this.topic = `conversation/${string(sessionId)}`; this.subscription = string(subscriptionId);
    this.current = null; this.cursor = -1; this.recovery = false;
    this.warn.clear();
  }
  ingest(value: unknown, generation: number): 'applied' | 'duplicate' | 'stale' {
    if (generation !== this.generation) return 'stale';
    try {
      // Parser supplies row/value context without exposing it to the diagnostic sink.
      const f = parseFrame(value, this.diagnostic);
      if (f.topic !== this.topic || f.subscriptionId !== this.subscription) return 'stale';
      if (f.payload.kind === 'snapshot') {
        if (this.current && f.payload.snapshot.logEpoch !== this.current.logEpoch) throw new ProtocolError('epoch-changed');
        if (this.current && f.toSeq <= this.cursor) return 'duplicate';
        this.current = structuredClone(f.payload.snapshot); this.cursor = f.toSeq; this.recovery = false;
        return 'applied';
      }
      if (!this.current || this.recovery) throw new ProtocolError('snapshot-required');
      if (f.toSeq <= this.cursor) return 'duplicate';
      if (f.fromSeq !== this.cursor) throw new ProtocolError('sequence-gap');
      const next = structuredClone(this.current);
      for (const d of f.payload.deltas) {
        if (d.op === 'state.updated') {
          const patch = record(d.patch);
          if ('logEpoch' in patch && patch.logEpoch !== next.logEpoch) throw new ProtocolError('epoch-changed');
          Object.assign(next, structuredClone(patch)); // whole-key replacement, never deep merge
        } else if (d.op === 'row.appended' || d.op === 'row.upserted') {
          const row = parseRow(d.row, this.diagnostic), index = next.rows.window.findIndex(r => r.rowId === row.rowId);
          if (d.op === 'row.appended') {
            if (index >= 0) {
              if (JSON.stringify(next.rows.window[index]) !== JSON.stringify(row)) throw new ProtocolError('row-identity-conflict');
              continue;
            }
            next.rows.window.push(row); next.rows.totalCount++; next.rows.firstRowId ??= row.rowId;
          } else if (index >= 0) next.rows.window[index] = row;
        } else if (d.op === 'row.delta') {
          const id = integer(d.rowId);
          if (typeof d.append !== 'string') throw new ProtocolError('invalid-append');
          const row = next.rows.window.find(r => r.rowId === id);
          if (!row) continue; // upstream unloaded-row semantics
          if (d.path === 'text' && ['assistantText', 'reasoning'].includes(row.kind)) row.text = String(row.text) + d.append;
          else if (d.path === 'inputText' && row.kind === 'toolCall') row.inputText = String(row.inputText ?? '') + d.append;
          else if (d.path === 'output.text' && row.kind === 'toolCall' && row.output) {
            const output = record(row.output);
            row.output = { ...output, text: String(output.text ?? '') + d.append };
          } else this.warn({ code: 'unsupported-stream-path' }, [this.generation, id, d.path]);
        } else if (d.op === 'row.removed') throw new ProtocolError('rewrite-requires-recovery');
        else if (d.op === 'workflowRun.updated' || d.op === 'workflowRun.removed') {
          string(d.runId);
          if (d.op === 'workflowRun.updated') integer(d.revision);
          this.warn({ code: 'workflow-projection-degraded' }, [this.generation, d.runId, d.op]);
        } else {
          this.warn({ code: 'unsupported-delta-operation' });
          throw new ProtocolError('unsupported-delta-operation');
        }
      }
      // Atomic commit: malformed later deltas cannot leave partial state behind.
      this.current = parseSnapshot(next, this.diagnostic); this.cursor = f.toSeq;
      return 'applied';
    } catch (e) { this.recovery = true; throw e; }
  }
}
