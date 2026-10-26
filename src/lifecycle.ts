import { threadDeltaSchema, threadDeltaNotificationParamsSchema, providerRecoveryNotificationSchema,
  jsonRpcEnvelopeSchema } from '@get-bb/plugin-sdk/provider-bridge';
import type { ThreadDelta } from '@get-bb/plugin-sdk/provider-bridge';
import { EventTranslator } from './translator.ts';
import { ProtocolError, integer, string } from './errors.ts';
import type { Warn } from './errors.ts';
import type { Snapshot } from './native.ts';
import type { CommandCorrelation } from './correlation.ts';
import { BackgroundTasks } from './background-tasks.ts';
import { Subagents } from './subagents.ts';

type Open = Extract<ThreadDelta, { kind: 'item.open' }>;
export type ComponentMessage = { jsonrpc: '2.0'; method: string; params: unknown };
// Policy component only: it neither spawns a child nor implements a bridge transport.
// Caller must supply real process ownership/cleanup in the future runtime integration.
export class SessionLifecycle {
  private translator: EventTranslator;
  private work = new Map<string, Open>();
  private attached = true;
  private ended = false;
  private cleanup: Promise<number> | null = null;
  private threadId: string;
  private sessionId: string;
  private epoch: string;
  private generation: number;
  private warn: Warn;
  private write: (message: ComponentMessage) => void;
  private release: () => Promise<number>;
  private backgrounds: BackgroundTasks;
  private subagents: Subagents;
  private cwd: string;
  constructor(threadId: string, sessionId: string, epoch: string, generation: number, warn: Warn,
    write: (message: ComponentMessage) => void, release: () => Promise<number>, cwd = '', taskStore?: string) {
    this.threadId = string(threadId); this.sessionId = string(sessionId); this.epoch = string(epoch);
    this.generation = integer(generation); this.warn = warn; this.write = write; this.release = release;
    this.cwd = cwd;
    this.translator = new EventTranslator(sessionId, epoch, generation, warn, cwd);
    this.backgrounds = new BackgroundTasks(sessionId, warn, taskStore);
    this.subagents = new Subagents(sessionId, epoch, warn);
  }
  private current(generation: number, sessionId: string): boolean {
    return this.attached && generation === this.generation && sessionId === this.sessionId;
  }
  private deltas(ds: ThreadDelta[]): void {
    if (ds.length) this.write({ jsonrpc: '2.0', method: 'thread/delta',
      params: threadDeltaNotificationParamsSchema.parse({ threadId: this.threadId, deltas: ds }) });
    // Like Codex emitTerminalAccountErrorHint: the bridge explicitly supplies
    // the standard hint; the SDK schema alone does not synthesize it.
    for (const d of ds) if (d.kind === 'provider.error' && d.willRetry !== true &&
      (d.category === 'rate-limit' || d.category === 'unauthorized')) {
      this.write({ jsonrpc: '2.0', method: 'provider/recovery', params: providerRecoveryNotificationSchema.parse({
        threadId: this.threadId, kind: d.category === 'rate-limit' ? 'rateLimited' : 'authRequired',
        message: d.message, retryable: false,
      }) });
    }
  }
  baseline(snapshot: Snapshot): void {
    this.translator.baseline(snapshot);
    this.deltas(this.subagents.baseline(snapshot));
    this.deltas(this.backgrounds.baseline(snapshot));
    this.backgrounds.recoveryDelivered();
  }
  project(snapshot: Snapshot, generation: number, sessionId: string, correlation?: CommandCorrelation): void {
    if (!this.current(generation, sessionId) || this.ended) return;
    const ds = this.translator.project(snapshot, generation, correlation);
    // Open parent tools before child delegations, close children before boundary.
    this.deltas(ds.filter(d => d.kind !== 'turn.boundary'));
    this.deltas(this.subagents.project(snapshot, ds));
    this.deltas(ds.filter(d => d.kind === 'turn.boundary'));
    this.deltas(this.backgrounds.project(snapshot, ds.some(d => d.kind === 'turn.boundary')));
  }
  // Tracks already translated background shapes. Native rich mapping is deferred to 3.3.
  openWork(delta: Open, generation: number, sessionId: string): void {
    if (!this.current(generation, sessionId) || this.ended) return;
    const parsed = threadDeltaSchema.parse(delta);
    if (parsed.kind !== 'item.open' || !['backgroundTask', 'delegation'].includes(parsed.item.type)) throw new ProtocolError('invalid-background-shape');
    const id = JSON.stringify([parsed.providerTurnId, parsed.key]);
    if (this.work.has(id)) throw new ProtocolError('duplicate-background-item');
    this.work.set(id, parsed);
    this.deltas([parsed]);
  }
  private closeWork(): void {
    const ds: ThreadDelta[] = [];
    for (const open of this.work.values()) {
      const item = open.item.type === 'backgroundTask' ? { ...open.item, status: 'failed', taskStatus: 'failed' } : open.item;
      ds.push(threadDeltaSchema.parse({ ...open, kind: 'item.close', item, status: 'failed' }));
    }
    this.deltas(ds); this.work.clear();
  }
  private finish(status: 'failed' | 'interrupted', correlation?: CommandCorrelation): void {
    // Background/delegation closes and translator item closes precede every boundary/reset.
    this.closeWork();
    this.deltas(this.subagents.settle(status));
    this.deltas(this.backgrounds.settle(status === 'interrupted' ? 'interrupt' : 'crash'));
    this.deltas(this.translator.settle(status, this.generation, correlation));
    this.ended = true;
  }
  private async free(): Promise<void> {
    this.cleanup ??= this.release();
    if (await this.cleanup !== 0) throw new ProtocolError('owned-resources-remain');
    this.backgrounds.cleanupSettled();
  }
  async processDied(generation: number, sessionId: string, correlation?: CommandCorrelation): Promise<void> {
    if (!this.current(generation, sessionId) || this.ended) return;
    this.finish('failed', correlation);
    const params = { threadId: this.threadId, providerThreadId: this.sessionId, message: 'Native child exited unexpectedly; resume required' };
    const message = { jsonrpc: '2.0' as const, method: 'error', params };
    jsonRpcEnvelopeSchema.parse(message); this.write(message);
    await this.free();
  }
  async stop(intent: 'interrupt' | 'release', generation: number, sessionId: string, correlation?: CommandCorrelation): Promise<void> {
    if (!this.current(generation, sessionId)) return;
    this.deltas(this.backgrounds.settle(intent));
    this.deltas(this.subagents.settle(intent === 'interrupt' ? 'interrupted' : 'failed'));
    if (!this.ended) this.finish(intent === 'interrupt' ? 'interrupted' : 'failed', correlation);
    // Release never invents interrupted; stop response belongs to the future caller after await.
    await this.free(); this.attached = false;
  }
  async replaced(sessionId: string, epoch: string, generation: number, contextPreserved?: boolean, correlation?: CommandCorrelation): Promise<void> {
    string(sessionId); string(epoch); integer(generation);
    if (generation <= this.generation) throw new ProtocolError('generation-not-increasing');
    if (contextPreserved === true && sessionId !== this.sessionId) throw new ProtocolError('replacement-context-conflict');
    if (!this.ended) this.finish('failed', correlation);
    await this.free();
    this.deltas([threadDeltaSchema.parse({ kind: 'session.reset' })]);
    const replacement = { jsonrpc: '2.0' as const, method: 'session/replaced', params: {
      threadId: this.threadId, providerThreadId: sessionId, reason: 'Explicit session replacement after cleanup',
      contextLost: contextPreserved !== true,
    } };
    jsonRpcEnvelopeSchema.parse(replacement); this.write(replacement);
    this.sessionId = sessionId; this.epoch = epoch; this.generation = generation;
    this.translator = new EventTranslator(sessionId, epoch, generation, this.warn, this.cwd);
    this.backgrounds = new BackgroundTasks(sessionId, this.warn);
    this.subagents = new Subagents(sessionId, epoch, this.warn);
    this.attached = true; this.ended = false; this.cleanup = null;
  }
}
