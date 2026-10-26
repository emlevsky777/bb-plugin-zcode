import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { experimental_recordProviderChildIo, sanitizeInheritedChildProcessEnv } from '@get-bb/plugin-sdk/provider-bridge';
import { JsonLineDecoder } from './framing.ts';
import { record } from './errors.ts';
import { catalogueSupervisor } from './catalogue-supervisor.ts';
import type { Duplex } from 'node:stream';

export interface Launch { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  onMissingFiles?: (() => void) | undefined }
export type GroupClassification = 'absent' | 'zombie-only' | 'live' | 'mixed' | 'unknown';
export class ProcessCleanupError extends Error {
  readonly stage: string;
  readonly code: string;
  readonly classification: GroupClassification;
  constructor(stage: string, code: string, classification: GroupClassification) {
    super(`Native cleanup ${stage}: ${code}; group=${classification}`);
    this.stage = stage; this.code = code; this.classification = classification;
  }
}
// No command lines: only owned group membership and OS status. Fault injection
// uses the same classifier as production; it is never an OS denial claim.
export function classifyOwnedGroup(pgid: number, ps = () => execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })): GroupClassification {
  try {
    const rows = ps().trim().split('\n');
    if (!rows.length || !rows[0]) return 'unknown';
    const states: string[] = [];
    for (const row of rows) {
      const fields = row.trim().split(/\s+/);
      if (fields.length !== 3 || !/^\d+$/.test(fields[0]!) || !/^\d+$/.test(fields[1]!)) return 'unknown';
      if (Number(fields[1]) === pgid) {
        if (!/^[RSDITZU][A-Za-z0-9+<>-]*$/.test(fields[2]!)) return 'unknown';
        states.push(fields[2]!.charAt(0));
      }
    }
    if (!states.length) return 'absent';
    if (states.every(s => s === 'Z')) return 'zombie-only';
    return states.includes('Z') ? 'mixed' : 'live';
  } catch { return 'unknown'; }
}
export class MissingExecutableError extends Error { readonly code = -32004; constructor(message = 'ZCode executable missing') { super(message); } }
export class NativeRequestTimeout extends Error {
  constructor() { super('Native request timeout; outcome unknown. The native process remains available; this request was not sent again.'); }
}
export function childEnvironment(parent: NodeJS.ProcessEnv, own: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = sanitizeInheritedChildProcessEnv({ env: parent });
  const env: NodeJS.ProcessEnv = { ...clean };
  // Storage belongs to the user, as in Desktop. Only session/login/log paths
  // are owned overrides; never inherit an obsolete isolated storage override.
  delete env.ZCODE_STORAGE_DIR;
  Object.assign(env, own);
  return env;
}
// Recording is a lossy safe projection. The recorder must never see auth payload,
// echoed stdout, model content, or unknown fields; real transport remains unchanged.
export function recordingProjection(value: unknown): string {
  try {
    const m = record(value);
    const methods = ['runtime/capabilities', 'v4/command', 'v4/conversation/subscribe', 'v4/conversation/frame',
      'session/read', 'session/requestRuntimePreferences', 'interaction/requestProviderRuntimeHeaders', 'provider/updateAccountConfig'];
    return JSON.stringify({ jsonrpc: '2.0', ...(typeof m.id === 'number' ? { id: m.id } : {}),
      ...(typeof m.method === 'string' && methods.includes(m.method) ? { method: m.method } : {}),
      ...(m.error ? { error: { code: Number(record(m.error).code) || -32000, message: '[redacted]' } } : {}),
      ...('result' in m ? { result: '[redacted]' } : {}), ...('params' in m ? { params: '[redacted]' } : {}) }) + '\n';
  } catch { return '{"redacted":true}\n'; }
}
export class NativeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly generation: number;
  readonly closed: Promise<void>;
  private finishClose!: () => void;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ordinal = 0;
  private current = true;
  private closing = false;
  private cleanup: Promise<number> | null = null;
  private finalized = false;
  private exitTimer: NodeJS.Timeout | undefined;
  private groupAbsent = false;
  private control: Duplex;
  nativePid: number | undefined;
  readonly cleanupDiagnostics: { stage: string; code: string; classification: GroupClassification }[] = [];
  readonly cleanupObservations: { at: string; pgid: number; signal: 0; code: string | null; classification: GroupClassification }[] = [];
  readonly ownedDescendantPids = new Set<number>();
  private descendantCleanupFailed = false;
  private escapedSettled = false;
  private signalEscapedSettled!: () => void;
  private escapedSettledProof = new Promise<void>(resolve => { this.signalEscapedSettled = resolve; });
  private cleanupFault: ProcessCleanupError | undefined;
  private decoder = new JsonLineDecoder(undefined, diagnostic => process.stderr.write(JSON.stringify(diagnostic) + '\n'));
  private tail = '';
  private recordedInput = new PassThrough();
  private recordedOutput = new PassThrough();
  private onMessage: (v: Record<string, unknown>, generation: number) => void;
  private onDeath: (error: Error, generation: number) => void;
  private onMissingFiles: Launch['onMissingFiles'];
  private requestTimeout: number;
  constructor(launch: Launch, generation: number, threadId: string | null,
    onMessage: (v: Record<string, unknown>, generation: number) => void,
    onDeath: (error: Error, generation: number) => void,
    requestTimeout = 60_000,
    recorder = experimental_recordProviderChildIo,
    privateGroupClassifier = classifyOwnedGroup) {
    this.generation = generation;
    this.onMessage = onMessage; this.onDeath = onDeath; this.requestTimeout = requestTimeout;
    this.onMissingFiles = launch.onMissingFiles;
    this.groupClassifier = privateGroupClassifier;
    this.closed = new Promise(r => { this.finishClose = r; });
    this.child = spawn(process.execPath, ['-e', catalogueSupervisor,
      Buffer.from(JSON.stringify({ executable: launch.executable, args: launch.args, control: true })).toString('base64')],
      { cwd: launch.cwd, env: { ...launch.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
        detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    this.control = this.child.stdio[3] as Duplex;
    const controlDecoder = new JsonLineDecoder(undefined, () => { throw new Error('Invalid supervisor control'); });
    this.control.on('error', () => { this.rememberCleanup(new ProcessCleanupError('control', 'UNKNOWN', 'unknown')); });
    this.control.on('data', chunk => {
      try {
        for (const value of controlDecoder.feed(chunk)) {
          const e = record(value);
          if (e.event === 'spawn' && typeof e.pid === 'number') this.nativePid = e.pid;
          else if (e.event === 'spawn-error') this.fail(e.code === 'ENOENT' ? new MissingExecutableError() : new Error('Native spawn failed'));
          else if (e.event === 'native-exit') this.rejectPending(new Error('Native child exited'));
          else if (e.event === 'stdin-error') this.fail(new Error('Native stdin failed'));
          else if (e.event === 'signal-error') this.rememberCleanup(new ProcessCleanupError(String(e.stage), String(e.code), 'unknown'));
          else if (e.event === 'descendant-owned' && Number.isSafeInteger(e.pid) && Number(e.pid) > 1) {
            // This is bounded diagnostic history, not the supervisor's live
            // ownership registry. A long command can report more than 4096
            // successive descendants without having 4096 live processes.
            // Keep receiving valid control events after the history fills.
            if (this.ownedDescendantPids.size < 4096) this.ownedDescendantPids.add(Number(e.pid));
          }
          else if (e.event === 'descendant-error') { this.descendantCleanupFailed = true; this.rememberCleanup(new ProcessCleanupError('descendants', 'SETTLEMENT_UNCONFIRMED', 'unknown')); }
          else if (e.event === 'escaped-settled') { this.escapedSettled = true; this.signalEscapedSettled(); }
          else throw new Error('Unknown supervisor event');
        }
      } catch { this.fail(new Error('Native supervisor control failed')); }
    });
    // Safe streams supplied immediately after spawn. Raw auth is deliberately excluded.
    recorder({ stdin: this.recordedInput, stdout: this.recordedOutput }, { threadId });
    this.recordedInput.resume();
    this.child.stdout.on('data', chunk => {
      if (!this.current) return;
      try {
        for (const value of this.decoder.feed(chunk)) {
          this.recordedOutput.write(recordingProjection(value));
          const m = record(value);
          if ('id' in m && !('method' in m)) {
            if (typeof m.id !== 'number') throw new Error('uncorrelated-native-response');
            const p = this.pending.get(m.id);
            if (!p) throw new Error('native-rpc-correlation-mismatch');
            clearTimeout(p.timer); this.pending.delete(m.id);
            if (m.error) p.reject(new Error('native-rpc-error'));
            else if ('result' in m) p.resolve(m.result);
            else p.reject(new Error('invalid-native-rpc-response'));
          } else this.onMessage(m, this.generation);
        }
      } catch { this.fail(new Error('Native stdout protocol failure; reconcile before retry')); }
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (!this.current) return;
      // All arbitrary native stderr is untrusted, including echoed auth. Retain
      // only bounded size observations, never raw text or secret-derived hashes.
      this.tail = (this.tail + `[redacted native stderr: ${chunk.length} bytes]\n`).slice(-8192);
    });
    this.child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (!this.current) return;
      if (e.code === 'EPIPE') this.handlerSignal('SIGKILL', 'stdin');
      this.fail(new Error('Native stdin failed'));
    });
    this.child.on('error', (e: NodeJS.ErrnoException) => {
      if (!this.current) return;
      this.fail(e.code === 'ENOENT' ? new MissingExecutableError() : new Error('Native spawn failed'));
    });
    this.child.on('exit', () => {
      if (!this.current) return;
      this.rejectPending(new Error('Native child exited'));
      // close normally follows exit; descendants may retain inherited pipes.
      this.exitTimer = setTimeout(() => { if (this.current) { this.handlerSignal('SIGKILL', 'exit-timer'); this.child.stdout.destroy(); this.child.stderr.destroy(); } }, 1000);
    });
    this.child.on('close', (code, signal) => {
      if (this.finalized) return;
      this.finalized = true;
      const wasCurrent = this.current; this.current = false;
      clearTimeout(this.exitTimer);
      this.rejectPending(new Error('Native child closed'));
      this.recordedInput.end(); this.recordedOutput.end(); this.finishClose();
      if (wasCurrent && !this.closing) this.onDeath(new Error(`Native child closed (code=${code}, signal=${signal}); ${this.tail}`), this.generation);
    });
  }
  private groupClassifier: typeof classifyOwnedGroup;
  activity(value: 'active' | 'idle' | 'unknown'): void {
    if (this.current && !this.closing && !this.control.destroyed) this.control.write(value + '\n');
  }
  private rejectPending(e: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); } this.pending.clear();
  }
  private fail(error: Error): void {
    if (!this.current) return;
    if (error instanceof MissingExecutableError) this.onMissingFiles?.();
    this.rejectPending(error);
    this.onDeath(error, this.generation);
    void this.close().catch(e => { this.rememberCleanup(e); });
  }
  private rememberCleanup(e: unknown): void {
    const error = e instanceof ProcessCleanupError ? e : new ProcessCleanupError('close', 'UNKNOWN', 'unknown');
    this.cleanupFault = error;
    this.cleanupDiagnostics.push({ stage: error.stage, code: error.code, classification: error.classification });
  }
  private handlerSignal(signal: NodeJS.Signals, stage: string): void {
    // Open pipe addresses this exact live supervisor; never signal a stale PGID.
    if (!this.finalized && !this.control.destroyed) this.control.write('abort\n');
  }
  private operation(signal: NodeJS.Signals | 0, stage: string): boolean {
    if (!this.child.pid || this.groupAbsent) return false;
    if (signal !== 0) throw new ProcessCleanupError(stage, 'OWNERSHIP_REQUIRED', 'unknown');
    try {
      process.kill(-this.child.pid, signal);
      this.cleanupObservations.push({ at: new Date().toISOString(), pgid: this.child.pid, signal: 0, code: null, classification: 'live' });
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      if (code === 'ESRCH') {
        this.cleanupObservations.push({ at: new Date().toISOString(), pgid: this.child.pid, signal: 0, code, classification: 'absent' });
        this.groupAbsent = true; return false;
      }
      const classification = code === 'EPERM' ? this.groupClassifier(this.child.pid) : 'unknown';
      this.cleanupObservations.push({ at: new Date().toISOString(), pgid: this.child.pid, signal: 0, code, classification });
      this.cleanupDiagnostics.push({ stage, code, classification });
      if (classification === 'absent' || classification === 'zombie-only') { this.groupAbsent = true; return false; }
      throw new ProcessCleanupError(stage, code, classification);
    }
  }
  private alive(): boolean { return this.operation(0, 'probe'); }
  private async settledProbe(): Promise<boolean> {
    // Darwin can expose an exiting member as ?E before reaping. Never classify
    // it as zombie: require a later authoritative probe within a bounded grace.
    for (let attempt = 0; ; attempt++) {
      try { return this.alive(); }
      catch (e) {
        if (!(e instanceof ProcessCleanupError) || e.code !== 'EPERM' || e.classification !== 'unknown' || attempt >= 20) throw e;
        await delay(50);
      }
    }
  }
  write(value: unknown): void {
    if (!this.current || this.closing) throw new Error('Native child unavailable');
    // ZCode's strict request/response schemas are NOT JSON-RPC2 envelopes.
    // bb envelopes stay on the host boundary; jsonrpc must not reach native.
    const m = record(value), native: Record<string, unknown> = {};
    for (const key of ['id', 'method', 'params', 'result', 'error']) if (key in m) native[key] = m[key];
    this.recordedInput.write(recordingProjection(native));
    this.child.stdin.write(JSON.stringify(native) + '\n');
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (!this.current || this.closing) return Promise.reject(new Error('Native child unavailable'));
    const id = ++this.ordinal;
    return new Promise((resolve, reject) => {
      // Expiry settles the caller, not the native operation. Keep its RPC ID
      // until a late response or release, so late ACK is not a protocol fault.
      const timer = setTimeout(() => reject(new NativeRequestTimeout()), this.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('Native write failed')); }
    });
  }
  close(): Promise<number> {
    return this.cleanup ??= this.release();
  }
  private async release(): Promise<number> {
    this.closing = true;
    this.child.stdin.end();
    // Supervisor owns bounded EOF/TERM/KILL while its lifetime anchors ownership.
    // Bridge observes only; losing that leader never grants numeric kill rights.
    await Promise.race([this.closed, delay(8000)]);
    const remaining = await this.settledProbe() || !this.finalized ? 1 : 0;
    if (!this.escapedSettled && !this.descendantCleanupFailed && this.finalized) await Promise.race([this.escapedSettledProof, delay(100)]);
    if (this.descendantCleanupFailed || !this.escapedSettled) throw new ProcessCleanupError('descendants', 'SETTLEMENT_UNCONFIRMED', 'unknown');
    // A transient handler error is resolved only by the final whole-group probe.
    if (remaining && this.cleanupFault) throw this.cleanupFault;
    return remaining;
  }
}
