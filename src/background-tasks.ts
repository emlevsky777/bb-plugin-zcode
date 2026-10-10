import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { threadDeltaSchema } from '@get-bb/plugin-sdk/provider-bridge';
import type { ThreadDelta } from '@get-bb/plugin-sdk/provider-bridge';
import type { Snapshot } from './native.ts';
import { record, ProtocolError } from './errors.ts';
import type { Warn } from './errors.ts';
type Task = { workId: string; key: string; closed: boolean; settled: boolean; description: string; status: string; signature: string };
// Never persist shell arguments or native title: either can contain credentials.
function safeDescription(command: unknown): string {
  if (typeof command !== 'string') return 'Bash (arguments not retained)';
  const token = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command.trim());
  const executable = (token?.[1] ?? token?.[2] ?? token?.[3] ?? '').split('/').at(-1);
  return `${['node', 'bash', 'sh', 'zsh', 'sleep', 'python', 'python3', 'npm', 'curl', 'find', 'grep', 'rg', 'git'].includes(executable ?? '') ? executable : 'Bash'} (arguments not retained)`;
}
export class BackgroundTasks {
  private tasks = new Map<string, Task>();
  private ignored = new Set<string>();
  private recovered: Task[] = [];
  private sessionId: string;
  private warn: Warn;
  private file: string | undefined;
  constructor(sessionId: string, warn: Warn, file?: string) {
    this.sessionId = sessionId; this.warn = warn; this.file = file;
    if (!file || !existsSync(file)) return;
    const bytes = readFileSync(file, 'utf8');
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw new ProtocolError('background-checkpoint-limit');
    const stored = record(JSON.parse(bytes));
    if ((stored.version !== 1 && stored.version !== 2) || stored.sessionId !== sessionId || !Array.isArray(stored.tasks) || stored.tasks.length > 4096 ||
        Object.keys(stored).some(k => !['version', 'sessionId', 'tasks', ...(stored.version === 1 ? ['supervisorPid'] : [])].includes(k)))
      throw new ProtocolError('background-checkpoint-invalid');
    for (const value of stored.tasks) {
      const t = record(value);
      if (typeof t.workId !== 'string' || !t.workId || typeof t.closed !== 'boolean' || t.key !== this.key(t.workId) || this.tasks.has(t.workId) ||
          Object.keys(t).some(k => !['workId', 'key', 'closed', ...(stored.version === 2 ? ['description'] : [])].includes(k)))
        throw new ProtocolError('background-checkpoint-invalid');
      if (stored.version === 2 && (typeof t.description !== 'string' || !/^(?:node|bash|sh|zsh|sleep|python|python3|npm|curl|find|grep|rg|git|Bash) \((?:arguments not retained|\u0430\u0440\u0433\u0443\u043c\u0435\u043d\u0442\u044b \u043d\u0435 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u044b)\)$/.test(t.description)))
        throw new ProtocolError('background-checkpoint-invalid');
      const task = { workId: t.workId, key: String(t.key), closed: t.closed, settled: t.closed,
        description: stored.version === 2 ? `${String(t.description).split(' ')[0]} (arguments not retained)` : 'Bash (arguments not retained)', status: 'failed', signature: '' };
      this.tasks.set(task.workId, task);
      if (!t.closed) this.recovered.push(task);
    }
  }
  private key(workId: string): string { return JSON.stringify([this.sessionId, 'background', workId]); }
  private persist(): void {
    if (!this.file) return;
    const value = JSON.stringify({ version: 2, sessionId: this.sessionId,
      tasks: [...this.tasks.values()].map(({ workId, key, closed, settled, description }) => ({ workId, key, closed: closed && settled, description })) });
    if (Buffer.byteLength(value) > 1024 * 1024) throw new ProtocolError('background-checkpoint-limit');
    const temp = this.file + '.tmp'; writeFileSync(temp, value, { encoding: 'utf8', mode: 0o600 }); renameSync(temp, this.file);
  }
  private shape(t: Task, taskStatus: string, description = 'Native background command') {
    return { type: 'backgroundTask', familyId: t.key, taskType: 'bash', description,
      status: taskStatus === 'completed' ? 'completed' : ['failed', 'killed'].includes(taskStatus) ? 'failed' : 'pending',
      taskStatus, skipTranscript: false };
  }
  baseline(s: Snapshot): ThreadDelta[] {
    for (const w of Array.isArray(s.backgroundWorks) ? s.backgroundWorks : []) {
      const v = record(w); if (typeof v.workId === 'string') this.ignored.add(v.workId);
    }
    return this.recovered.map(t => threadDeltaSchema.parse({ kind: 'provider.warning', category: 'general',
      summary: `The provider restarted while background command ${t.description} was running.`,
      details: `Work ID: ${t.workId}. Successful completion is unconfirmed. The previous card may remain running until you stop or archive the thread.` }));
  }
  recoveryDelivered(): void {
    for (const t of this.recovered) { t.closed = true; t.settled = true; }
    this.persist(); this.recovered = [];
  }
  cleanupSettled(): void {
    for (const t of this.tasks.values()) if (t.closed) t.settled = true;
    this.persist();
  }
  project(s: Snapshot, foregroundBoundary = false): ThreadDelta[] {
    const output: ThreadDelta[] = [], seen = new Set<string>();
    const emit = (value: unknown) => output.push(threadDeltaSchema.parse(value));
    for (const value of Array.isArray(s.backgroundWorks) ? s.backgroundWorks : []) {
      const w = record(value);
      if (w.kind !== 'bash') continue;
      if (typeof w.workId !== 'string' || !w.workId || typeof w.title !== 'string' ||
          !['running', 'resultPending', 'failed', 'cancelled'].includes(String(w.status))) {
        this.warn({ code: 'unknown-background-task' }); continue;
      }
      seen.add(w.workId);
      if (this.ignored.has(w.workId)) continue;
      let task = this.tasks.get(w.workId);
      if (task?.closed) continue;
      if (!task) {
        const anchor = s.rows.window.find(r => r.kind === 'toolCall' && r.toolName === 'Bash' &&
          (r.workId === w.workId || r.rowId === w.anchorRowId ||
            // Installed0.16.9 omits optional workId/backgrounded and reports a
            // null anchor. Exact native model-content prefix is source-backed
            // by29628c9 bash-model-content120-142 and actual M3 recording.
            (r.status === 'success' && r.input && typeof r.input === 'object' && !Array.isArray(r.input) &&
              record(r.input).run_in_background === true && r.output && typeof r.output === 'object' &&
              typeof record(r.output).text === 'string' &&
              String(record(r.output).text).startsWith(`Command running in background with ID: ${w.workId}.`))));
        if (!anchor?.turnId) { this.warn({ code: 'background-anchor-unavailable' }, w.workId); continue; }
        if (this.tasks.size >= 4096) throw new ProtocolError('background-ledger-limit');
        task = { workId: w.workId, key: this.key(w.workId), closed: false, settled: false,
          description: safeDescription(record(anchor.input).command), status: 'running', signature: '' };
        this.tasks.set(w.workId, task); this.persist();
        emit({ kind: 'item.open', providerTurnId: anchor.turnId, key: { providerItemId: task.key }, item: this.shape(task, 'running', w.title) });
      }
      const taskStatus = w.status === 'resultPending' ? 'completed' : w.status === 'cancelled' ? 'killed' : String(w.status);
      const item = this.shape(task, taskStatus, w.title), signature = JSON.stringify(item);
      if (taskStatus === 'running') {
        if (foregroundBoundary || task.signature !== signature) emit({ kind: 'item.progress', key: { providerItemId: task.key }, snapshot: item, flush: true });
      } else {
        task.closed = true; task.settled = true; this.persist();
        emit({ kind: 'item.close', key: { providerItemId: task.key }, item, status: taskStatus === 'completed' ? 'completed' : 'failed' });
      }
      task.signature = signature; task.status = taskStatus;
    }
    for (const task of this.tasks.values()) if (!task.closed && !seen.has(task.workId)) {
      this.warn({ code: 'background-outcome-unconfirmed' }, task.workId);
      task.closed = true; this.persist();
      emit({ kind: 'item.close', key: { providerItemId: task.key }, item: { ...this.shape(task, 'failed'),
        error: 'Native background work disappeared without a terminal observation' }, status: 'failed' });
    }
    return output;
  }
  settle(intent: 'interrupt' | 'release' | 'crash'): ThreadDelta[] {
    const ds: ThreadDelta[] = [];
    for (const t of this.tasks.values()) if (!t.closed) {
      t.closed = true;
      ds.push(threadDeltaSchema.parse({ kind: 'item.close', key: { providerItemId: t.key }, status: 'failed',
        // bb sends release for Stop after foreground boundary. Both explicit
        // Stop intents terminate the command; crash alone is an unknown failure.
        item: this.shape(t, intent === 'crash' ? 'failed' : 'killed') }));
    }
    this.persist(); return ds;
  }
}
