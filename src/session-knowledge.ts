import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Snapshot } from './native.ts';
import type { BbSkill } from './bb-skills.ts';

// Stored with bb's own native session, never in HOME/configuration. Pending
// means dispatch may have happened: an ACK cannot resolve that uncertainty.
export class SessionKnowledge {
  private state: { block: string; commandId: string | null; delivered: boolean; everDelivered: boolean; skills: BbSkill[]; frozen: boolean; compacts: string[]; needsReconcile: boolean };
  private file: string | undefined;
  constructor(file?: string) {
    this.file = file;
    this.state = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { block: '', commandId: null, delivered: false, everDelivered: false, skills: [], frozen: false, compacts: [], needsReconcile: false };
  }
  get delivered() { return this.state.delivered; }
  get started() { return this.state.frozen; }
  get skills() { return this.state.skills; }
  get needsReconcile() { return this.state.needsReconcile; }
  observe(snapshot: Snapshot) {
    let changed = false;
    if (this.state.commandId && !this.state.delivered && snapshot.rows.window.some(r => r.kind === 'turnHeader' && r.sourceCommandId === this.state.commandId)) {
      this.state.delivered = true; this.state.everDelivered = true; changed = true;
    }
    for (const row of snapshot.rows.window) {
      if (row.kind !== 'timelineMarker') continue;
      const marker = row.marker as Record<string, unknown> | undefined;
      if (marker?.type !== 'compact' || marker.status !== 'success') continue;
      const key = `${row.turnId}:${row.rowId}`;
      if (this.state.compacts.includes(key)) continue;
      this.state.compacts.push(key); changed = true;
      if (this.state.frozen && this.state.block) this.state.needsReconcile = true;
    }
    if (changed) this.save();
  }
  reconcile(messages: unknown[]) {
    const retained = activeNativeMessages(messages).some(m => {
      const parts = (m as { parts?: { type?: string; text?: string; ignored?: boolean }[] }).parts;
      return parts?.filter(p => p.type === 'text' && !p.ignored).map(p => p.text ?? '').join('').includes(this.state.block);
    });
    if (!retained) { this.state.commandId = null; this.state.delivered = false; }
    this.state.needsReconcile = false; this.save();
    return retained;
  }
  prepare(id: string, block: string, text: string, skills: BbSkill[] = []) {
    if (this.state.delivered) return text;
    if (this.state.commandId) return text; // Never repeat an uncertain prefix.
    if (this.state.frozen) { block = this.state.block; skills = this.state.skills; }
    this.state = { ...this.state, block, commandId: id, delivered: false, skills, frozen: true }; this.save();
    return block ? block + '\n\n' + text : text;
  }
  rejected(id: string) {
    if (this.state.commandId === id && !this.state.delivered) { this.state.commandId = null; if (!this.state.everDelivered) this.state.frozen = false; this.save(); }
  }
  private save() {
    if (!this.file) return;
    const temp = this.file + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 }); renameSync(temp, this.file);
  }
}

// CLI .16.9 compactActiveSessionMessages / compactPreservedSegmentMessages:
// the last active boundary replaces older messages, with an optional tail
// reinserted after its anchor. Full history alone is not active model context.
export function activeNativeMessages(input: unknown[]): unknown[] {
  const messages = input as { info: { id: string; role?: string; semantics?: { providerVisibility?: string }; error?: unknown }; parts: { type: string; compactBoundary?: { preservedSegment?: { headMessageId: string; tailMessageId: string; anchorMessageId: string } }; timelineStatus?: string }[] }[];
  let boundary = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i]!.parts.some(p => p.type === 'compaction' && (p.compactBoundary || !p.timelineStatus))) boundary = i;
  if (boundary < 0) return messages;
  const active = messages.slice(boundary), segment = messages[boundary]!.parts.find(p => p.type === 'compaction' && p.compactBoundary)?.compactBoundary?.preservedSegment;
  if (!segment) return active;
  const head = messages.findIndex(m => m.info.id === segment.headMessageId), tail = messages.findIndex(m => m.info.id === segment.tailMessageId);
  if (head < 0 || tail < head || tail >= boundary) return active;
  const preserved = messages.slice(head, tail + 1).filter(m => m.info.semantics?.providerVisibility !== 'hidden' && !m.parts.some(p => p.type === 'compaction') &&
    !(m.info.role === 'assistant' && m.info.error) && ['user', 'assistant'].includes(m.info.role ?? ''));
  const anchor = active.findIndex(m => m.info.id === segment.anchorMessageId), position = anchor >= 0 ? anchor + 1 : 1;
  return [...active.slice(0, position), ...preserved, ...active.slice(position)];
}
