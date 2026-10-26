import { ProtocolError, string, integer, record } from './errors.ts';

export interface Identity { namespace: string; sessionId: string }
export function encodeIdentity(identity: Identity): string {
  return JSON.stringify(['zcode-v1', string(identity.namespace), string(identity.sessionId)]);
}
export function restoreIdentity(handle: string, namespace: string): Identity {
  let parsed: unknown;
  try { parsed = JSON.parse(handle); } catch { throw new ProtocolError('invalid-resume-identity'); }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== 'zcode-v1' || parsed[1] !== namespace) throw new ProtocolError('invalid-resume-identity');
  return { namespace: string(parsed[1]), sessionId: string(parsed[2]) };
}
type Pending = { clientRequestId: string; generation: number; deadline: number; ack: boolean; outcome: 'pending' | 'unknown' | 'accepted' | 'rejected'; turnId?: string };
export class CommandCorrelation {
  private commands = new Map<string, Pending>();
  private generation = -1;
  private retired = new Map<string, number>();
  private retire(commandId: string, generation: number): void {
    this.commands.delete(commandId);
    this.retired.set(commandId, generation);
    if (this.retired.size > 256) this.retired.delete(this.retired.keys().next().value!);
  }
  begin(commandId: string, clientRequestId: string, generation: number, deadline: number): void {
    string(commandId);
    string(clientRequestId);
    integer(generation);
    integer(deadline);
    if (generation < this.generation) throw new ProtocolError('stale-command-generation');
    if (generation > this.generation) {
      for (const command of this.commands.values()) {
        if (command.outcome === 'pending') command.outcome = 'unknown';
      }
      this.generation = generation;
    }
    if (this.commands.has(commandId) || this.retired.has(commandId)) throw new ProtocolError('duplicate-command');
    this.commands.set(commandId, { clientRequestId, generation, deadline, ack: false, outcome: 'pending' });
  }
  ack(commandId: string, generation: number): boolean {
    const p = this.commands.get(commandId);
    if (!p || p.generation !== generation || generation !== this.generation) return false;
    p.ack = true; return true; // admission ACK never input acceptance or terminal
  }
  expire(now: number): void {
    for (const p of this.commands.values()) if (p.outcome === 'pending' && now >= p.deadline) p.outcome = 'unknown';
  }
  authoritative(commandId: string, generation: number, outcome: 'inputAccepted' | 'rejected', turnId?: string): boolean {
    const p = this.commands.get(commandId);
    if (!p || p.generation !== generation || generation !== this.generation || p.outcome === 'accepted' || p.outcome === 'rejected') return false;
    if (outcome === 'inputAccepted') {
      p.turnId = string(turnId);
      p.outcome = 'accepted';
    }
    else {
      p.outcome = 'rejected';
      this.retire(commandId, generation);
    }
    return true;
  }
  acceptance(commandId: string, generation: number): { clientRequestId: string; providerTurnId: string } | null {
    const p = this.commands.get(commandId);
    return generation === this.generation && p?.generation === generation && p.outcome === 'accepted' && p.turnId
      ? { clientRequestId: p.clientRequestId, providerTurnId: p.turnId } : null;
  }
  accepted(generation: number): { commandId: string; clientRequestId: string; providerTurnId: string }[] {
    const result = [];
    for (const commandId of this.commands.keys()) {
      const value = this.acceptance(commandId, generation);
      if (value) result.push({ commandId, ...value });
    }
    return result;
  }
  status(commandId: string): string | null { return this.commands.get(commandId)?.outcome ?? null; }
  unresolved(generation: number): { commandId: string; clientRequestId: string }[] {
    return [...this.commands].filter(([, p]) => p.generation === generation && ['pending', 'unknown'].includes(p.outcome))
      .map(([commandId, p]) => ({ commandId, clientRequestId: p.clientRequestId }));
  }
  abandon(commandId: string, generation: number): void {
    if (this.commands.get(commandId)?.generation === generation) this.retire(commandId, generation);
  }
  // Consume only after the input.accepted projection commits atomically.
  consume(commandId: string, generation: number): boolean {
    const p = this.commands.get(commandId);
    if (!p || p.generation !== generation || p.outcome !== 'accepted') return false;
    this.retire(commandId, generation);
    return true;
  }
  clear(): void {
    this.commands.clear();
    this.retired.clear();
  }
}

// RPC completion remains separate from authoritative input acceptance.
export class RpcReplies {
  private pending = new Set<string | number>();
  private generation: number;
  constructor(generation: number) { this.generation = integer(generation); }
  begin(id: string | number): void {
    if (typeof id === 'string') string(id); else integer(id);
    if (this.pending.has(id)) throw new ProtocolError('duplicate-rpc');
    this.pending.add(id);
  }
  response(value: unknown, generation: number): { kind: 'stale' } | { kind: 'result'; value: unknown } {
    if (generation !== this.generation) return { kind: 'stale' };
    const r = record(value);
    if (r.jsonrpc !== '2.0' || !['string', 'number'].includes(typeof r.id) || 'method' in r ||
        (('result' in r) === ('error' in r))) throw new ProtocolError('invalid-native-rpc-response');
    const id = r.id as string | number;
    if (!this.pending.has(id)) throw new ProtocolError('native-rpc-correlation-mismatch');
    if ('error' in r) {
      const error = record(r.error);
      if (!Number.isSafeInteger(error.code) || typeof error.message !== 'string') throw new ProtocolError('invalid-native-rpc-response');
      this.pending.delete(id);
      throw new ProtocolError('native-rpc-error'); // never forward raw message/data or secrets
    }
    this.pending.delete(id);
    return { kind: 'result', value: r.result };
  }
}
