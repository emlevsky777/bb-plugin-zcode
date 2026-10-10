import { ProtocolError, record, string, integer } from './errors.ts';
import type { Warn } from './errors.ts';

export interface Row extends Record<string, unknown> { rowId: number; kind: string; turnId?: string }
export interface Snapshot extends Record<string, unknown> {
  logEpoch: string;
  rows: { window: Row[]; totalCount: number; firstRowId: number | null };
}
export interface Frame {
  topic: string; subscriptionId: string; fromSeq: number; toSeq: number;
  payload: { kind: 'snapshot'; snapshot: Snapshot } | { kind: 'deltas'; deltas: Record<string, unknown>[] };
}
const enums: Record<string, readonly string[]> = {
  turnHeader: ['running', 'completedSuccess', 'failed', 'completedInterrupted'],
  assistantText: ['streaming', 'complete', 'interrupted', 'failed'], reasoning: ['streaming', 'complete', 'interrupted'],
  toolCall: ['inputStreaming', 'pendingApproval', 'running', 'success', 'error', 'cancelled'],
  hookInvocation: ['running', 'completed', 'failed'],
  subagent: ['running', 'success', 'failed', 'cancelled'],
};
export function parseRow(value: unknown, warn: Warn): Row {
  const r = record(value);
  integer(r.rowId); string(r.kind);
  if (r.turnId !== undefined) string(r.turnId);
  const known = enums[r.kind as string];
  const checkEnum = (value: unknown, values: readonly string[]) => {
    string(value);
    if (!values.includes(value as string)) warn({ code: 'unknown-row-enum' }, [r.rowId, r.kind, value]);
  };
  if (r.kind === 'userInput') {
    if (typeof r.text !== 'string') throw new ProtocolError('invalid-text');
    checkEnum(r.origin, ['realUser', 'backgroundResult', 'goalContinuation', 'mailbox', 'synthetic', 'workflowLaunch']);
  }
  if (r.kind === 'timelineMarker') {
    const marker = record(r.marker);
    checkEnum(marker.type, ['compact', 'forkNotice', 'forkCreated', 'modelChange', 'goalSet', 'goalVerify', 'retryNotice', 'checkpointRestored']);
    if (r.lane !== undefined) checkEnum(r.lane, ['assistantWork', 'turnTailBoundary', 'lightBoundary']);
    if (marker.type === 'compact') {
      checkEnum(marker.origin, ['manual', 'auto']); checkEnum(marker.status, ['running', 'success', 'failed', 'noop', 'cancelled']);
    }
    if (marker.type === 'goalVerify') checkEnum(marker.outcome, ['running', 'pass', 'notSatisfied', 'failed']);
  }
  if (!known && !['userInput', 'timelineMarker'].includes(r.kind as string)) warn({ code: 'unknown-row-kind' }, [r.rowId, r.kind]);
  else if (known) {
    string(r.turnId);
    const state = ['toolCall', 'subagent'].includes(r.kind as string) ? r.status : r.state;
    string(state);
    if (!known.includes(state as string)) warn({ code: 'unknown-row-enum' }, [r.rowId, r.kind, state]);
    if (r.kind === 'assistantText' || r.kind === 'reasoning') {
      if (typeof r.text !== 'string') throw new ProtocolError('invalid-text');
    }
    if (r.kind === 'toolCall') string(r.toolName);
  }
  return structuredClone(r) as Row;
}
export function parseSnapshot(value: unknown, warn: Warn): Snapshot {
  const s = record(value), rows = record(s.rows);
  string(s.logEpoch); integer(rows.totalCount);
  if (rows.firstRowId !== null) integer(rows.firstRowId);
  if (!Array.isArray(rows.window)) throw new ProtocolError('invalid-rows');
  if (rows.window.length > 4096 || Buffer.byteLength(JSON.stringify(s)) > 16 * 1024 * 1024) throw new ProtocolError('snapshot-limit');
  const window = rows.window.map(r => parseRow(r, warn));
  if (new Set(window.map(r => r.rowId)).size !== window.length) throw new ProtocolError('duplicate-snapshot-row');
  return { ...structuredClone(s), logEpoch: s.logEpoch as string,
    rows: { ...structuredClone(rows), window, totalCount: rows.totalCount as number, firstRowId: rows.firstRowId as number | null } };
}
export function parseFrame(value: unknown, warn: Warn): Frame {
  const f = record(value), p = record(f.payload);
  const fromSeq = integer(f.fromSeq), toSeq = integer(f.toSeq);
  if (toSeq < fromSeq) throw new ProtocolError('invalid-sequence-range');
  const base = { topic: string(f.topic), subscriptionId: string(f.subscriptionId), fromSeq, toSeq };
  if (p.kind === 'snapshot') return { ...base, payload: { kind: 'snapshot', snapshot: parseSnapshot(p.snapshot, warn) } };
  if (p.kind !== 'deltas' || !Array.isArray(p.deltas)) throw new ProtocolError('invalid-payload');
  return { ...base, payload: { kind: 'deltas', deltas: p.deltas.map(d => structuredClone(record(d))) } };
}
