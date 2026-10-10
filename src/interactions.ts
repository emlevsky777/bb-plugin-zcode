import { ProtocolError, integer, string } from './errors.ts';
export type AnswerChannel = 'reverseRpc' | 'v4';
export type AuthoritativeOutcome = 'human' | 'auto-resolution' | 'cancelled' | 'unknown';
interface Interaction {
  id: string; generation: number; state: 'pending' | 'resolved' | 'cancelled';
  visibleAt?: number; deadlineAt?: number; proposed?: unknown; channel?: AnswerChannel; applied?: unknown;
  outcome: AuthoritativeOutcome;
}
// Local component only. Caller must supply native authoritative resolutions.
export class InteractionArbiter {
  private entries = new Map<string, Interaction>();
  private generation = -1;
  private compact(): void {
    const completed = [...this.entries].filter(([, item]) => item.state !== 'pending');
    for (const [key] of completed.slice(0, Math.max(0, completed.length - 256))) {
      this.entries.delete(key);
    }
  }
  private key(id: string, generation: number): string { return JSON.stringify([generation, id]); }
  observe(id: string, generation: number, times: { visibleAt?: number; deadlineAt?: number } = {}): void {
    string(id);
    integer(generation);
    if (generation < this.generation) throw new ProtocolError('stale-interaction-generation');
    if (generation > this.generation) {
      for (const entry of this.entries.values()) {
        if (entry.state === 'pending') {
          entry.state = 'cancelled'; // Local invalidation, outcome stays unknown.
          delete entry.proposed;
        }
      }
      this.generation = generation;
    }
    if (times.visibleAt !== undefined) integer(times.visibleAt);
    if (times.deadlineAt !== undefined) integer(times.deadlineAt);
    const key = this.key(id, generation);
    let item = this.entries.get(key);
    if (!item) {
      if ([...this.entries.values()].filter(entry => entry.state === 'pending').length >= 1024) throw new ProtocolError('interaction-limit');
      item = { id, generation, state: 'pending', outcome: 'unknown' };
      this.entries.set(key, item);
    }
    this.compact();
    // First native timestamp wins independently; absence does not invent one.
    if (item.visibleAt === undefined && times.visibleAt !== undefined) item.visibleAt = times.visibleAt;
    if (item.deadlineAt === undefined && times.deadlineAt !== undefined) item.deadlineAt = times.deadlineAt;
  }
  propose(id: string, generation: number, channel: AnswerChannel, answer: unknown): boolean {
    if (generation !== this.generation) return false;
    const item = this.entries.get(this.key(id, generation));
    if (!item || item.state !== 'pending' || item.channel !== undefined) return false;
    item.proposed = structuredClone(answer); item.channel = channel;
    return true; // permission to dispatch once, not applied answer
  }
  ack(id: string, generation: number, _accepted: boolean): boolean {
    if (generation !== this.generation) return false;
    return this.entries.has(this.key(id, generation)); // no state/effect mutation, including late accepted ACK
  }
  resolve(id: string, generation: number, answer: unknown, outcome: AuthoritativeOutcome = 'unknown'): boolean {
    if (generation !== this.generation) return false;
    const item = this.entries.get(this.key(id, generation));
    if (!item || item.state !== 'pending') return false;
    if (!['human', 'auto-resolution', 'cancelled', 'unknown'].includes(outcome)) throw new ProtocolError('invalid-authoritative-outcome');
    item.state = outcome === 'cancelled' ? 'cancelled' : 'resolved';
    item.outcome = outcome;
    item.applied = structuredClone(answer);
    delete item.proposed;
    this.compact();
    return true;
  }
  cancel(id: string, generation: number): boolean {
    if (generation !== this.generation) return false;
    const item = this.entries.get(this.key(id, generation));
    if (!item || item.state !== 'pending') return false;
    item.state = 'cancelled';
    item.outcome = 'cancelled';
    delete item.proposed;
    this.compact();
    return true;
  }
  inspect(id: string, generation: number): Interaction | null {
    const item = this.entries.get(this.key(id, generation)); return item ? structuredClone(item) : null;
  }
  clear(): void { this.entries.clear(); }
}
