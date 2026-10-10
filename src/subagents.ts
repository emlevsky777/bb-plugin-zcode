import { threadDeltaSchema } from '@get-bb/plugin-sdk/provider-bridge';
import type { ThreadDelta } from '@get-bb/plugin-sdk/provider-bridge';
import type { Snapshot } from './native.ts';
import { record, boundedWarnings } from './errors.ts';
import type { Warn } from './errors.ts';

type Child = { key: string; turnId: string; childId: string; parentId: string; background: boolean; closed: boolean; signature: string; label: string; summary: string };
// Projection only: ZCode owns execution, task IDs and cancellation. childRef is
// the actual native session identity, never a fabricated bb thread reference.
export class Subagents {
  private children = new Map<number, Child>();
  private turns = new Set<string>();
  private ignored = new Set<number>();
  private warn: Warn;
  private sessionId: string;
  private epoch: string;
  constructor(sessionId: string, epoch: string, warn: Warn) { this.sessionId = sessionId; this.epoch = epoch; this.warn = boundedWarnings(warn); }
  baseline(snapshot: Snapshot): ThreadDelta[] {
    for (const row of snapshot.rows.window) if (row.kind === 'subagent') {
      this.ignored.add(row.rowId);
      if (row.status === 'running') this.warn({ code: 'subagent-resume-outcome-unconfirmed' }, row.rowId);
    }
    return [];
  }
  project(snapshot: Snapshot, deltas: ThreadDelta[]): ThreadDelta[] {
    for (const d of deltas) if (d.kind === 'turn.open' && d.providerTurnId) this.turns.add(d.providerTurnId);
    const out: ThreadDelta[] = [];
    const emit = (value: unknown) => out.push(threadDeltaSchema.parse(value));
    for (const row of snapshot.rows.window) {
      if (row.kind !== 'subagent' || this.ignored.has(row.rowId)) continue;
      let child = this.children.get(row.rowId);
      if (child?.closed) continue;
      if (typeof row.turnId !== 'string' || !this.turns.has(row.turnId)) continue;
      if (!['running', 'success', 'failed', 'cancelled'].includes(String(row.status)) ||
          typeof row.subagentType !== 'string' || !row.subagentType || typeof row.summaryText !== 'string' ||
          typeof row.childSessionId !== 'string' || !row.childSessionId || typeof row.parentToolCallId !== 'string' || !row.parentToolCallId) {
        this.warn({ code: 'subagent-identity-or-outcome-unconfirmed' }, row.rowId); continue;
      }
      const anchor = snapshot.rows.window.find(r => r.kind === 'toolCall' && r.toolName === 'Agent' &&
        r.toolCallId === row.parentToolCallId && r.turnId === row.turnId);
      if (!anchor) { this.warn({ code: 'subagent-parent-unconfirmed' }, row.rowId); continue; }
      const background = row.backgrounded === true || record(anchor.input).run_in_background === true;
      if (child && (child.childId !== row.childSessionId || child.parentId !== row.parentToolCallId || (child.background && !background))) {
        this.warn({ code: 'subagent-identity-conflict' }, row.rowId); continue;
      }
      const key = { providerItemId: JSON.stringify([this.sessionId, this.epoch, row.rowId, 'subagent']),
        parentRef: JSON.stringify([this.sessionId, this.epoch, anchor.rowId, 'toolCall']) };
      const item = { type: 'delegation', childRef: row.childSessionId, label: `ZCode ${row.subagentType}`,
        background, summary: row.summaryText };
      if (!child) {
        if (this.children.size >= 4096) {
          for (const [id, prior] of this.children) if (prior.closed) { this.children.delete(id); this.ignored.add(id); }
          if (this.children.size >= 4096) { this.warn({ code: 'subagent-ledger-limit' }); continue; }
        }
        child = { key: key.providerItemId, turnId: row.turnId, childId: row.childSessionId, parentId: row.parentToolCallId,
          background, closed: false, signature: '', label: item.label, summary: item.summary };
        this.children.set(row.rowId, child);
        emit({ kind: 'item.open', providerTurnId: row.turnId, key, item });
      }
      child.background = background;
      // A foreground boundary does not settle background agents. A running
      // native work overrides an inconsistent success row; resultPending alone
      // cannot establish success without the child terminal row.
      const work = Array.isArray(snapshot.backgroundWorks) ? snapshot.backgroundWorks.find(w => record(w).workId === row.workId) : undefined;
      const workStatus = work ? record(work).status : undefined;
      const knownWork = workStatus === undefined || ['running', 'resultPending', 'failed', 'cancelled'].includes(String(workStatus));
      const terminal = row.status !== 'running' && knownWork && workStatus !== 'running';
      if (!knownWork || (row.status === 'success' && workStatus === 'running')) this.warn({ code: 'subagent-work-outcome-unconfirmed' }, row.rowId);
      if (terminal) {
        const status = row.status === 'cancelled' || workStatus === 'cancelled' ? 'interrupted' :
          row.status === 'failed' || workStatus === 'failed' ? 'failed' : 'completed';
        emit({ kind: 'item.close', ...(!background ? { providerTurnId: row.turnId } : {}), key, item, status }); child.closed = true;
      } else if (child.signature !== JSON.stringify(item)) emit({ kind: 'item.progress', key, snapshot: item, flush: true });
      child.signature = JSON.stringify(item);
      child.summary = row.summaryText;
    }
    for (const d of deltas) if (d.kind === 'turn.boundary') {
      for (const child of this.children.values()) if (child.turnId === d.providerTurnId && !child.background && !child.closed) {
        this.warn({ code: 'subagent-terminal-unconfirmed' }, child.childId);
        emit({ kind: 'item.close', providerTurnId: child.turnId, key: { providerItemId: child.key },
          item: this.shape(child), status: d.status === 'interrupted' ? 'interrupted' : 'failed' });
        child.closed = true;
      }
    }
    return out;
  }
  private shape(child: Child) { return { type: 'delegation', childRef: child.childId, label: child.label, summary: child.summary, background: child.background }; }
  settle(status: 'failed' | 'interrupted'): ThreadDelta[] {
    const out: ThreadDelta[] = [];
    for (const child of this.children.values()) if (!child.closed) {
      out.push(threadDeltaSchema.parse({ kind: 'item.close', ...(!child.background ? { providerTurnId: child.turnId } : {}), key: { providerItemId: child.key }, item: this.shape(child), status })); child.closed = true;
    }
    return out;
  }
}
