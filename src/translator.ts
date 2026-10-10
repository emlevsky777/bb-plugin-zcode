import { createHash } from 'node:crypto';
import { threadDeltaSchema } from '@get-bb/plugin-sdk/provider-bridge';
import type { ThreadDelta } from '@get-bb/plugin-sdk/provider-bridge';
import { ProtocolError, record, string, integer, boundedWarnings } from './errors.ts';
import type { Warn } from './errors.ts';
import type { Snapshot, Row } from './native.ts';
import type { CommandCorrelation } from './correlation.ts';
import { inspectExecution, headerOutcomes } from './execution.ts';
import type { Outcome } from './execution.ts';
import { richTool, richPresentation } from './rich-tools.ts';
import { serviceError } from './service-errors.ts';

const terminal = headerOutcomes;
const LIMIT = 4096;
const MAX_BYTES = 1024 * 1024;
const PAYLOAD_BYTES = 32 * 1024 * 1024;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
interface ItemLedger {
  turnId: string;
  rowId: number;
  kind: string;
  length: number;
  prefix: string;
  closed: boolean;
  tool?: string;
}
interface TurnLedger { rowId: number; terminal: boolean; synthetic?: boolean }
interface Ledger {
  turns: Map<string, TurnLedger>;
  items: Map<string, ItemLedger>;
  retiredThrough: number;
}
function empty(): Ledger {
  return { turns: new Map(), items: new Map(), retiredThrough: -1 };
}

// v2: bounded IDs/positions/text hashes only. Tool payload signatures never persist.
export class EventTranslator {
  private ledger: Ledger = empty();
  private payloads = new Map<string, Row>();
  private suppressUnaccepted = false;
  private warn: ReturnType<typeof boundedWarnings>;
  private sessionId: string;
  private epoch: string;
  private generation: number;
  private cwd: string;
  constructor(sessionId: string, epoch: string, generation: number, warn: Warn, cwd = '') {
    string(sessionId);
    string(epoch);
    integer(generation);
    this.sessionId = sessionId;
    this.epoch = epoch;
    this.generation = generation;
    this.cwd = cwd;
    this.warn = boundedWarnings(warn);
  }
  private key(row: Pick<Row, 'rowId' | 'kind'>): string {
    return JSON.stringify([this.sessionId, this.epoch, row.rowId, row.kind]);
  }
  // A fresh attach observes native history; bb already owns its representation.
  // This is not a completed-success assertion or an in-flight recovery terminal.
  baseline(snapshot: Snapshot): void {
    if (snapshot.logEpoch !== this.epoch) throw new ProtocolError('translator-epoch-mismatch');
    if (this.ledger.turns.size || this.ledger.items.size) throw new ProtocolError('baseline-already-projected');
    for (const row of snapshot.rows.window) {
      if (typeof row.turnId === 'string' && !this.ledger.turns.has(row.turnId))
        this.ledger.turns.set(row.turnId, { rowId: row.rowId, terminal: true, synthetic: true });
      this.ledger.retiredThrough = Math.max(this.ledger.retiredThrough, row.rowId);
    }
    this.suppressUnaccepted = true;
  }
  checkpoint(): string {
    const result = JSON.stringify({ version: 2, sessionId: this.sessionId, epoch: this.epoch,
      retiredThrough: this.ledger.retiredThrough, turns: [...this.ledger.turns], items: [...this.ledger.items], suppressUnaccepted: this.suppressUnaccepted });
    if (Buffer.byteLength(result) > MAX_BYTES) throw new ProtocolError('checkpoint-limit');
    return result;
  }
  restore(checkpoint: string): void {
    if (Buffer.byteLength(checkpoint) > MAX_BYTES) throw new ProtocolError('checkpoint-limit');
    let p: Record<string, unknown>;
    try { p = record(JSON.parse(checkpoint)); } catch { throw new ProtocolError('invalid-checkpoint'); }
    if (p.sessionId !== this.sessionId || p.epoch !== this.epoch) throw new ProtocolError('checkpoint-context-mismatch');
    if (p.version !== 2) throw new ProtocolError('unsupported-checkpoint-version');
    if (p.suppressUnaccepted !== undefined && typeof p.suppressUnaccepted !== 'boolean') throw new ProtocolError('invalid-checkpoint');
    const retired = p.retiredThrough === -1 ? -1 : integer(p.retiredThrough);
    const turns = new Map<string, TurnLedger>(), items = new Map<string, ItemLedger>();
    if (!Array.isArray(p.turns) || !Array.isArray(p.items) || p.turns.length > LIMIT || p.items.length > LIMIT) throw new ProtocolError('invalid-checkpoint');
    for (const pair of p.turns) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new ProtocolError('invalid-checkpoint');
      const id = string(pair[0]), v = record(pair[1]);
      if (typeof v.terminal !== 'boolean' || (integer(v.rowId) <= retired && v.synthetic !== true) || turns.has(id) ||
          (v.synthetic !== undefined && typeof v.synthetic !== 'boolean')) throw new ProtocolError('invalid-checkpoint');
      turns.set(id, { rowId: integer(v.rowId), terminal: v.terminal, ...(v.synthetic === true ? { synthetic: true } : {}) });
    }
    for (const pair of p.items) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new ProtocolError('invalid-checkpoint');
      const id = string(pair[0]), v = record(pair[1]);
      const kind = string(v.kind), turnId = string(v.turnId), rowId = integer(v.rowId);
      if (!['assistantText', 'reasoning', 'toolCall'].includes(kind) || !turns.has(turnId) ||
          typeof v.closed !== 'boolean' || typeof v.prefix !== 'string' || !/^[a-f0-9]{64}$/.test(v.prefix) ||
          id !== this.key({ rowId, kind }) || items.has(id)) throw new ProtocolError('invalid-checkpoint');
      const item: ItemLedger = { turnId, rowId, kind, length: integer(v.length), prefix: v.prefix, closed: v.closed };
      if (kind === 'toolCall') {
        item.tool = string(v.tool);
        if (item.length !== 0 || item.prefix !== digest('')) throw new ProtocolError('invalid-checkpoint');
      }
      items.set(id, item);
    }
    this.ledger = { turns, items, retiredThrough: retired };
    this.suppressUnaccepted = p.suppressUnaccepted === true;
    this.payloads.clear(); // checkpoint is metadata-only, never a transcript store
  }
  project(snapshot: Snapshot, generation: number, correlation?: CommandCorrelation): ThreadDelta[] {
    return this.projectSnapshot(snapshot, generation, correlation, new Set());
  }
  private projectSnapshot(snapshot: Snapshot, generation: number, correlation: CommandCorrelation | undefined, syntheticHeaders: Set<string>): ThreadDelta[] {
    if (generation !== this.generation) return [];
    if (snapshot.logEpoch !== this.epoch) throw new ProtocolError('translator-epoch-mismatch');
    if (snapshot.sessionId !== undefined && snapshot.sessionId !== this.sessionId) throw new ProtocolError('translator-session-mismatch');
    const ledger = structuredClone(this.ledger), output: ThreadDelta[] = [];
    const payloads = structuredClone(this.payloads);
    let suppressUnaccepted = this.suppressUnaccepted;
    const consumed: string[] = [];
    const emit = (delta: unknown): void => { output.push(threadDeltaSchema.parse(delta)); };
    const execution = inspectExecution(snapshot, this.warn);
    const admissions = correlation?.accepted(generation) ?? [];
    const groups = new Map<string, Row[]>(), headers = new Map<string, Row>();
    for (const row of snapshot.rows.window) {
      if (row.kind === 'turnHeader') headers.set(string(row.turnId), row);
      else if (['assistantText', 'reasoning', 'toolCall'].includes(row.kind)) {
        const id = string(row.turnId), group = groups.get(id) ?? [];
        group.push(row);
        groups.set(id, group);
      }
    }
    for (const accepted of admissions) {
      if ([...headers.values()].some(h => h.sourceCommandId === accepted.commandId && h.turnId !== accepted.providerTurnId)) throw new ProtocolError('command-turn-conflict');
      const header = headers.get(accepted.providerTurnId);
      if (header?.sourceCommandId !== undefined && header.sourceCommandId !== accepted.commandId) throw new ProtocolError('command-turn-conflict');
      if (!header) {
        syntheticHeaders.add(accepted.providerTurnId);
        headers.set(accepted.providerTurnId, { rowId: ledger.turns.get(accepted.providerTurnId)?.rowId ??
        groups.get(accepted.providerTurnId)?.[0]?.rowId ?? 0, kind: 'turnHeader', turnId: accepted.providerTurnId,
        sourceCommandId: accepted.commandId });
      }
    }
    // Already opened turns remain identifiable even when the entire window moves away.
    for (const [id, turn] of ledger.turns) if (!turn.terminal && !headers.has(id)) {
      if (turn.synthetic) syntheticHeaders.add(id);
      headers.set(id, { rowId: turn.rowId, kind: 'turnHeader', turnId: id });
    }
    for (const [id, group] of groups) {
      if (headers.has(id)) continue;
      if (ledger.turns.get(id)?.terminal) continue;
      const activeRows = group.some(r => r.state === 'streaming' || ['running', 'pendingApproval', 'inputStreaming'].includes(String(r.status)));
      if (activeRows && execution.known && execution.active && groups.size === 1 && !suppressUnaccepted) {
        syntheticHeaders.add(id);
        headers.set(id, { rowId: group[0]!.rowId, kind: 'turnHeader', turnId: id, state: 'running' });
      } else if (activeRows) {
        if (suppressUnaccepted) { this.warn({ code: 'unaccepted-turn-suppressed' }, [generation, id]); continue; }
        throw new ProtocolError('missing-active-turn-header');
      } else {
        for (const row of group) this.warn({ code: 'historical-row-skipped' }, [generation, id, row.rowId]);
      }
    }
    const liveIds = [...headers].filter(([id, h]) => !ledger.turns.get(id)?.terminal &&
      (ledger.turns.has(id) || h.state === 'running' || admissions.some(a => a.providerTurnId === id))).map(([id]) => id);
    for (const [turnId, header] of headers) {
      const existing = ledger.turns.get(turnId);
      if (existing && !existing.synthetic && existing.rowId !== header.rowId) throw new ProtocolError('turn-identity-conflict');
      const admission = admissions.find(a => a.providerTurnId === turnId);
      const commandId = admission?.commandId;
      const acceptance = admission ?? null;
      if (acceptance) {
        if (acceptance.providerTurnId !== turnId) throw new ProtocolError('command-turn-conflict');
        consumed.push(commandId!);
      }
      if (existing?.terminal) {
        if (acceptance) emit({ kind: 'input.accepted', clientRequestId: acceptance.clientRequestId, providerTurnId: turnId });
        continue;
      }
      if (!existing && !acceptance && typeof header.sourceCommandId === 'string' &&
          ['pending', 'unknown'].includes(correlation?.status(header.sourceCommandId) ?? '')) {
        this.warn({ code: 'input-acceptance-unconfirmed' }, [generation, turnId]); continue;
      }
      // Completed history is owned by bb, even under new IDs or shifted native windows.
      if (!existing && !acceptance && ((terminal[String(header.state)] !== undefined || header.state === undefined) || suppressUnaccepted)) {
        if (suppressUnaccepted && header.state === 'running') this.warn({ code: 'unaccepted-turn-suppressed' }, [generation, turnId]);
        continue;
      }
      if (header.rowId <= ledger.retiredThrough && !acceptance && !existing) continue;
      if (!existing) emit({ kind: 'turn.open', providerTurnId: turnId });
      if (acceptance) {
        emit({ kind: 'input.accepted', clientRequestId: acceptance.clientRequestId, providerTurnId: turnId });
        suppressUnaccepted = false;
      }
      ledger.turns.set(turnId, { rowId: header.rowId, terminal: false,
        ...(syntheticHeaders.has(turnId) && (!existing || existing.synthetic) ? { synthetic: true } : {}) });
      let status = terminal[String(header.state)];
      if (execution.present) {
        if (!execution.known || execution.blocked) {
          if (status && execution.blocked) this.warn({ code: 'conflicting-terminal-sources' }, [generation, turnId]);
          status = undefined;
        }
        else if (liveIds.length === 1 && liveIds[0] === turnId && execution.outcome) {
          if (header.state !== undefined && (header.state === 'running' || !status || status !== execution.outcome)) {
            this.warn({ code: 'conflicting-terminal-sources' }, [generation, turnId]); status = undefined;
          } else status = execution.outcome;
        } else if (status && execution.foregroundActive) {
          this.warn({ code: 'conflicting-terminal-sources' }, [generation, turnId]); status = undefined;
        }
      }
      for (const row of groups.get(turnId) ?? []) {
        const id = this.key(row), key = { providerItemId: id }, prior = ledger.items.get(id);
        if (row.kind === 'toolCall') {
          if (prior?.closed) continue;
          if (row.status === 'inputStreaming') continue;
          const tool = string(row.toolName);
          if (prior && prior.tool !== tool) throw new ProtocolError('tool-identity-conflict');
          const item = richTool(row, this.cwd, this.warn);
          const presentation = richPresentation(row, item);
          if (!prior) emit({ kind: 'item.open', providerTurnId: turnId, key, item, presentation });
          const closed = ['success', 'error', 'cancelled'].includes(String(row.status));
          if (closed) emit({ kind: 'item.close', providerTurnId: turnId, key, item, presentation,
            status: row.status === 'success' ? 'completed' : row.status === 'cancelled' ? 'interrupted' : 'failed',
            resultText: row.output ? String(record(row.output).text ?? '') : '' });
          ledger.items.set(id, { turnId, rowId: row.rowId, kind: row.kind, tool, length: 0, prefix: digest(''), closed });
        } else {
          const text = typeof row.text === 'string' ? row.text : '';
          const channel = row.kind === 'assistantText' ? 'agentMessage' : 'reasoningText';
          const length = prior?.length ?? 0;
          if (text.length < length || digest(text.slice(0, length)) !== (prior?.prefix ?? digest(''))) throw new ProtocolError('text-rewrite-requires-recovery');
          if (prior?.closed) {
            if (text.length !== length) throw new ProtocolError('closed-item-rewrite');
            continue;
          }
          if (!prior) emit({ kind: 'item.open', providerTurnId: turnId, key,
            item: channel === 'reasoningText' ? { type: 'reasoning', summary: [], content: [] } : { type: 'agentMessage', text: '' } });
          if (text.length > length) emit({ kind: 'item.textDelta', providerTurnId: turnId, key, channel, text: text.slice(length) });
          const closed = ['complete', 'interrupted', 'failed'].includes(String(row.state));
          if (closed) emit({ kind: 'item.textClose', providerTurnId: turnId, key, channel, text });
          ledger.items.set(id, { turnId, rowId: row.rowId, kind: row.kind, length: text.length, prefix: digest(text), closed });
        }
        payloads.set(id, structuredClone(row));
      }
      const open = [...ledger.items].filter(([, item]) => item.turnId === turnId && !item.closed);
      if (status) {
        for (const [id, item] of open) {
          const key = { providerItemId: id };
          if (item.kind === 'toolCall') {
            const row = payloads.get(id);
            const knownTool = row && ['pendingApproval', 'running', 'success', 'error', 'cancelled'].includes(String(row.status));
            if (row && !knownTool) this.warn({ code: 'unknown-tool-outcome-closed' }, [generation, id]);
            if (status === 'completed' && row?.status !== 'success') this.warn({ code: 'terminal-tool-outcome-unconfirmed' }, [generation, id]);
            emit({ kind: 'item.close', providerTurnId: turnId, key, status: knownTool && status !== 'completed' ? status : 'failed',
              item: row ? richTool(row, this.cwd, this.warn) : { type: 'tool', tool: item.tool },
              ...(row ? { presentation: richPresentation(row, richTool(row, this.cwd, this.warn)) } : {}),
              ...(row?.output ? { resultText: String(record(row.output).text ?? '') } : {}) });
            if (!row) this.warn({ code: 'terminal-tool-payload-unavailable' }, [generation, id]);
          } else {
            const row = payloads.get(id);
            if (!row) this.warn({ code: 'terminal-text-payload-unavailable' }, [generation, id]);
            emit({ kind: 'item.textClose', providerTurnId: turnId, key,
              channel: item.kind === 'assistantText' ? 'agentMessage' : 'reasoningText',
              ...(row ? { text: String(row.text) } : {}) });
          }
          item.closed = true;
        }
      }
      if (status) {
        if (status === 'failed' && execution.outcome === 'failed' && liveIds.length === 1 && liveIds[0] === turnId) {
          const error = serviceError(record(snapshot.control).lastError);
          if (error) emit({ ...error, providerTurnId: turnId });
        }
        emit({ kind: 'turn.boundary', providerTurnId: turnId, status });
        ledger.turns.get(turnId)!.terminal = true;
        if (status !== 'completed') suppressUnaccepted = true;
        for (const [id, item] of ledger.items) if (item.turnId === turnId) payloads.delete(id);
      } else if (header.state !== 'running') this.warn({ code: 'unknown-terminal-state' }, [generation, turnId, header.state]);
    }
    // Compact only completed oldest prefix, never evict an active turn.
    const ordered = [...ledger.turns].sort((a, b) => a[1].rowId - b[1].rowId);
    for (const [id, turn] of ordered) {
      if (!turn.terminal) break;
      if (ledger.turns.size <= 256 && ledger.items.size <= LIMIT) break;
      if (!turn.synthetic) ledger.retiredThrough = Math.max(ledger.retiredThrough, turn.rowId);
      ledger.turns.delete(id);
      for (const [key, item] of ledger.items) if (item.turnId === id) ledger.items.delete(key);
    }
    const metadata = JSON.stringify({ version: 2, sessionId: this.sessionId, epoch: this.epoch,
      retiredThrough: ledger.retiredThrough, turns: [...ledger.turns], items: [...ledger.items] });
    if (ledger.turns.size > LIMIT || ledger.items.size > LIMIT || Buffer.byteLength(metadata) + 40 > MAX_BYTES ||
        Buffer.byteLength(JSON.stringify([...payloads])) > PAYLOAD_BYTES) throw new ProtocolError('translator-ledger-limit');
    this.ledger = ledger;
    this.payloads = payloads;
    this.suppressUnaccepted = suppressUnaccepted;
    for (const id of consumed) correlation?.consume(id, generation);
    return output;
  }
  // Local terminal policy for crash/stop/replacement; never a native settlement claim.
  settle(status: Outcome, generation: number, correlation?: CommandCorrelation): ThreadDelta[] {
    if (generation !== this.generation) return [];
    const rows: Row[] = [];
    const synthetic = new Set<string>();
    for (const [id, turn] of this.ledger.turns) if (!turn.terminal) {
      if (turn.synthetic) synthetic.add(id);
      rows.push({ rowId: turn.rowId, kind: 'turnHeader', turnId: id,
        state: status === 'completed' ? 'completedSuccess' : status === 'failed' ? 'failed' : 'completedInterrupted' });
    }
    for (const accepted of correlation?.accepted(generation) ?? []) if (!rows.some(r => r.turnId === accepted.providerTurnId) && !this.ledger.turns.get(accepted.providerTurnId)?.terminal) {
      synthetic.add(accepted.providerTurnId);
      rows.push({ rowId: 0, kind: 'turnHeader', turnId: accepted.providerTurnId, sourceCommandId: accepted.commandId,
        state: status === 'completed' ? 'completedSuccess' : status === 'failed' ? 'failed' : 'completedInterrupted' });
    }
    return this.projectSnapshot({ logEpoch: this.epoch, rows: { window: rows, firstRowId: rows[0]?.rowId ?? null, totalCount: rows.length } }, generation, correlation, synthetic);
  }
}
