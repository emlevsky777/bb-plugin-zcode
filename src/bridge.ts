import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridgeIo, createBridgeLineHandler, runBridgeRequest,
  bridgeRequestEnvelopeSchema, initializeParamsSchema, modelListParamsSchema,
  threadStartParamsSchema, threadResumeParamsSchema, threadStopParamsSchema,
  turnStartParamsSchema, turnSteerParamsSchema, threadDiscardParamsSchema, PROVIDER_BRIDGE_PROTOCOL_VERSION,
  providerRecoveryNotificationSchema, threadDeltaSchema, skillsConfigureParamsSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { NativeProcess, MissingExecutableError } from './process.ts';
import type { Launch } from './process.ts';
import { FrameDecoder } from './framing.ts';
import { ConversationState } from './state.ts';
import { SessionLifecycle } from './lifecycle.ts';
import { CommandCorrelation } from './correlation.ts';
import { ReadOnlyAuth, authRecovery, accountProviderId, AuthError, authMode, UnsupportedPlanError } from './auth.ts';
import { signInHint } from './applications.ts';
import type { AuthMode } from './auth.ts';
import { record, string } from './errors.ts';
import { NativeRequestTimeout } from './process.ts';
import type { Snapshot } from './native.ts';
import type { Row } from './native.ts';
import { executionOptions } from './options.ts';
import { retainedRows, retentionDifference } from './retention.ts';
import { InteractionArbiter } from './interactions.ts';
import { nativeQuestion, nativeAnswer, questionTurn } from './questions.ts';
import { inspectExecution } from './execution.ts';
import { convertAttachments, createAttachmentRefs, requireImageCapability } from './attachments.ts';
import { convertMentions, selectedMentions, resolveMentionTarget, compactSelection } from './mentions.ts';
import { CompactionProjection } from './compaction.ts';
import { createDiagnosticReporter } from './messages.ts';
import { SessionKnowledge } from './session-knowledge.ts';
import { ProjectTokenError } from './project-token.ts';
import { bbOnlySkills, skillsBlock } from './bb-skills.ts';
import type { SkillRoot, BbSkill } from './bb-skills.ts';

export const runtimePreferences = { nativeSearchEnhancementsEnabled: true, memoryEnabled: true,
  askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' };
export const bridgeCapabilities = { grammarVersions: [3, 3] as [number, number], sessionRestore: true,
  fork: 'none' as const, skills: { configure: true }, approvalEnforcedBy: 'provider' as const,
  threadArchive: false, threadRename: false, threadGoalClear: false, steerMode: 'inject' as const };
export interface RuntimeSetup { launch: Launch; auth: ReadOnlyAuth; refreshAuth?: (child: NativeProcess) => Promise<void>; configure: (child: NativeProcess) => Promise<void>; bindSession?: ((id: string) => void) | undefined; markCreatePending?: (() => void) | undefined; readySession?: ((child: NativeProcess, id: string) => Promise<void>) | undefined }
export interface BridgeServices {
  memoryEnabled?: () => boolean | undefined;
  compatibility?: () => { message: string | null };
  compatibilityWarning?: () => string | null;
  claimDiagnostic?: (threadId: string, code: string) => boolean;
  observe?: (value: Record<string, unknown>) => void;
  prepare: (cwd: string, execution?: ReturnType<typeof executionOptions>, identity?: { threadId: string; providerThreadId?: string }) => Promise<RuntimeSetup>;
  health: (mode?: AuthMode) => Promise<unknown>;
  installation: () => Promise<unknown>;
  models: (cwd?: string, mode?: AuthMode, refresh?: number) => Promise<unknown>;
  validateSelection: (model: string, reasoning: string, mode?: AuthMode, refresh?: number) => Promise<void | { model: string; reasoning: string }>;
}
export interface RuntimeSetup { warnings?: readonly string[] | undefined; beforeInput?: (() => Promise<void>) | undefined }
export interface RuntimeSetup { mentionCatalogue?: ((side: 'skills' | 'commands') => Promise<unknown>) | undefined; backgroundTaskStore?: string | undefined }
export interface RuntimeSetup { knowledgeStore?: string | undefined }
type Session = { threadId: string; id: string; cwd: string; model: string; reasoning: string; generation: number; child: NativeProcess;
  auth: ReadOnlyAuth; refreshAuth: RuntimeSetup['refreshAuth']; beforeInput: RuntimeSetup['beforeInput']; state: ConversationState; decoder: FrameDecoder; lifecycle: SessionLifecycle | null;
  correlation: CommandCorrelation; detached: boolean; closing: boolean; subscription: string | null; options: string;
  construction: Record<string, unknown>; memoryEnabled: boolean; instructionMode: string; timers: Map<string, ReturnType<typeof setTimeout>>;
  interactions: InteractionArbiter; questions: Map<string, { rpcId: string | number; bbId: string; question: ReturnType<typeof nativeQuestion>; sent: boolean }>;
  steerRequests: Set<string>;
  compactions: CompactionProjection;
  mentionCatalogue: RuntimeSetup['mentionCatalogue'];
  backgroundTaskStore: RuntimeSetup['backgroundTaskStore'];
  knowledgeStore: RuntimeSetup['knowledgeStore'];
  knowledge: SessionKnowledge;
  skillRoots: SkillRoot[];
  bbSkills: BbSkill[];
  mentionCatalogues: Map<string, Promise<unknown>>;
  stopping?: Promise<void> };

export function createZCodeBridge(services: BridgeServices, write: (message: unknown) => void) {
  function currentExecution(options: unknown, instructionMode: string, disallowed: unknown) {
    const execution = executionOptions(options, instructionMode, disallowed);
    execution.memoryEnabled = services.memoryEnabled?.() ?? execution.memoryEnabled;
    execution.signature = JSON.stringify([Object.entries(execution.envVars).sort(), execution.toolDenylist, execution.memoryEnabled]);
    return execution;
  }
  const io = createBridgeIo({ write: line => write(JSON.parse(line)) });
  const sessions = new Map<string, Session>();
  let skillRoots: SkillRoot[] = [];
  const operations = new Map<string, Promise<void>>();
  let generation = 0;
  let pluginId = 'zcode';
  let closing: Promise<void> | undefined;
  const createdIdentities = new Map<string, string>();
  const questionResponses = new Map<string, Session>();
  const send = (method: string, params: unknown) => io.send({ jsonrpc: '2.0', method, params });
  function current(s: Session, g: number): boolean { return !s.detached && s.generation === g && sessions.get(s.threadId) === s; }
  const reportDiagnostic = createDiagnosticReporter(value => services.observe?.(value), (threadId, summary) => {
    send('thread/delta', { threadId, deltas: [{ kind: 'provider.warning', category: 'general',
      summary }] });
  }, services.claimDiagnostic);
  const warning = (threadId: string) => (diagnostic: { code: string }) => reportDiagnostic(threadId, diagnostic.code);
  function project(s: Session): void {
    const snapshot = s.state.snapshot;
    if (!snapshot || !s.lifecycle) return;
    s.knowledge.observe(snapshot);
    const execution = inspectExecution(snapshot, warning(s.threadId));
    s.child.activity(!execution.known ? 'unknown' : execution.active || execution.waiting ? 'active' : 'idle');
    for (const row of snapshot.rows.window) if (row.kind === 'turnHeader' && typeof row.sourceCommandId === 'string' && typeof row.turnId === 'string') {
      s.correlation.authoritative(row.sourceCommandId, s.generation, 'inputAccepted', row.turnId);
    }
    // Native compact has its own turnHeader. Its visible turn is owned by the
    // compact projection, including queued operations; do not open it twice.
    const compactTurns = new Set(snapshot.rows.window.filter(r => r.kind === 'turnHeader' && s.compactions.owns(r.sourceCommandId)).map(r => r.turnId));
    const ordinarySnapshot = compactTurns.size ? { ...snapshot, rows: { ...snapshot.rows,
      window: snapshot.rows.window.filter(r => !compactTurns.has(r.turnId)) } } : snapshot;
    s.lifecycle.project(ordinarySnapshot, s.generation, s.id, s.correlation);
    s.compactions.project(snapshot);
    for (const [id, timer] of s.timers) if (!['pending', 'unknown'].includes(s.correlation.status(id) ?? '')) {
      clearTimeout(timer); s.timers.delete(id);
    }
    flushQuestions(s);
  }
  function flushQuestions(s: Session): void {
    if (!s.state.snapshot || !s.lifecycle || s.closing) return;
    for (const [requestId, pending] of s.questions) {
      if (pending.sent) continue;
      const turnId = questionTurn(s.state.snapshot, pending.question);
      if (turnId === null) continue;
      pending.sent = true;
      questionResponses.set(pending.bbId, s);
      io.send({ jsonrpc: '2.0', id: pending.bbId, method: 'interaction/request', params: {
        threadId: s.threadId, providerThreadId: s.id, turnId, providerNativeIds: true, payload: pending.question.payload } });
      services.observe?.({ event: 'question-requested', threadId: s.threadId, sessionId: s.id,
        requestId, bbId: pending.bbId, generation: s.generation, businessTurnId: pending.question.turnId,
        providerTurnId: turnId, toolCallId: pending.question.toolCallId });
    }
  }
  function closePending(s: Session): void {
    for (const timer of s.timers.values()) clearTimeout(timer);
    s.timers.clear();
    for (const p of s.correlation.unresolved(s.generation)) {
      services.observe?.({ event: 'pending-closed', threadId: s.threadId, commandId: p.commandId, outcome: 'unknown' });
      send('error', { threadId: s.threadId, providerThreadId: s.id,
        message: 'Native input outcome unknown; reconcile before retry' });
      s.correlation.abandon(p.commandId, s.generation);
    }
  }
  function cancelQuestions(s: Session): void {
    for (const [id, pending] of s.questions) {
      s.interactions.cancel(id, s.generation);
      questionResponses.delete(pending.bbId);
      if (!s.detached) {
        try { s.child.write({ jsonrpc: '2.0', id: pending.rpcId, result: { action: 'cancel' } }); }
        catch { services.observe?.({ event: 'question-cancel-dispatch-unavailable', threadId: s.threadId,
          sessionId: s.id, requestId: id, generation: s.generation }); }
      }
      services.observe?.({ event: 'question-cancelled', threadId: s.threadId, sessionId: s.id, requestId: id, generation: s.generation });
    }
    s.questions.clear();
  }
  function authFailed(s: Session): void {
    send('provider/recovery', providerRecoveryNotificationSchema.parse({ threadId: s.threadId,
      kind: 'authRequired', message: signInHint(), retryable: false }));
    send('thread/delta', { threadId: s.threadId, deltas: [threadDeltaSchema.parse({ kind: 'provider.error',
      category: 'unauthorized', message: signInHint() })] });
  }
  function nativeMessage(s: Session, m: Record<string, unknown>, g: number): void {
    if (!current(s, g) || s.closing) return;
    if (m.method === 'session/requestRuntimePreferences') {
      const preferences = { ...runtimePreferences, memoryEnabled: s.memoryEnabled };
      services.observe?.({ event: 'runtime-preferences', threadId: s.threadId, sessionId: s.id, generation: g, ...preferences });
      s.child.write({ jsonrpc: '2.0', id: m.id, result: preferences });
    } else if (m.method === 'interaction/requestProviderRuntimeHeaders') {
      const params = record(m.params);
      services.observe?.({ event: 'runtime-headers-request', sessionId: s.id, requestId: params.requestId,
        generation: g, readsBefore: s.auth.reads, source: s.auth.source(), route: 'coding-plan-gateway', model: record(params.modelSelection).modelId });
      let headersApplied = false;
      void (async () => { try {
        const models = record(await services.models(s.cwd, s.auth.source(), Number(record(record(s.construction.options).providerOptions ?? {}).catalogueRefresh ?? 0))).models;
        const available = Array.isArray(models) ? models.map(m => string(record(m).model)) : [];
        if (!current(s, g) || s.closing) return;
        const result = await s.auth.runtimeHeaders(m.params, s.id, s.cwd, s.model, s.reasoning, available);
        if (!current(s, g) || s.closing) return;
        s.child.write({ jsonrpc: '2.0', id: m.id, result }); headersApplied = true; }
      catch (e) {
        if (!current(s, g) || s.closing) return;
        const missingLogin = (e instanceof AuthError && e.kind === 'unauthenticated') || (e instanceof ProjectTokenError && e.code === 'project_token_login_failed');
        s.child.write({ jsonrpc: '2.0', id: m.id, result: { headersApplied: false,
          errorMessage: missingLogin ? signInHint() : e instanceof UnsupportedPlanError ? e.message : e instanceof ProjectTokenError ? e.code : 'Unsupported or invalid native auth input' } });
        if (missingLogin) authFailed(s);
        else send('thread/delta', { threadId: s.threadId, deltas: [threadDeltaSchema.parse({ kind: 'provider.error',
          category: e instanceof UnsupportedPlanError ? 'bad-request' : 'unknown', message: e instanceof UnsupportedPlanError ? e.message : e instanceof ProjectTokenError ? e.code : 'Unsupported or invalid native auth input; inspect configuration' })] });
      }
      services.observe?.({ event: 'runtime-headers-result', sessionId: s.id, requestId: params.requestId,
        generation: g, readsAfter: s.auth.reads, source: s.auth.source(), route: 'coding-plan-gateway', headersApplied });
      })();
    } else if (m.method === 'v4/conversation/frame') {
      const f = s.decoder.ingest(m.params);
      if (!f || f.topic !== `conversation/${s.id}`) return;
      if (!s.subscription) { s.subscription = f.subscriptionId; s.state.attach(g, s.id, f.subscriptionId); }
      if (s.state.ingest(f, g) === 'applied') {
        const snapshot = s.state.snapshot!;
        services.observe?.({ event: 'native-state', sessionId: s.id, generation: g,
          threadId: s.threadId, pid: s.child.child.pid, nativePid: s.child.nativePid, config: snapshot.config, control: snapshot.control,
          rows: snapshot.rows.window.map(r => ({ rowId: r.rowId, kind: r.kind, turnId: r.turnId,
            sourceCommandId: r.sourceCommandId, state: r.state, toolName: r.toolName, status: r.status,
            ...(r.kind === 'timelineMarker' ? { marker: r.marker } : {}),
            toolCallId: r.toolCallId, workId: r.workId, backgrounded: r.backgrounded,
            ...(r.kind === 'subagent' ? { parentToolCallId: r.parentToolCallId, childSessionId: r.childSessionId,
              subagentType: r.subagentType, summaryText: r.summaryText } : {}),
            ...(r.kind === 'userInput' ? { guided: r.guided, origin: r.origin } : {}),
            ...(r.kind === 'hookInvocation' ? { hookEventName: r.hookEventName, hookCount: r.hookCount,
              executions: Array.isArray(r.executions) ? r.executions.map(value => {
                const e = record(value); return { didExecute:e.didExecute,state:e.state,outcome:e.outcome,sourceKind:e.sourceKind,pluginName:e.pluginName };
              }) : undefined } : {}),
            ...(r.kind === 'userInput' && Array.isArray(r.attachments) ? { attachments: r.attachments.map(a => {
              const meta = record(a); return { filenameSha256: typeof meta.fileName === 'string' ? createHash('sha256').update(meta.fileName).digest('hex') : null,
                mime: meta.mime, bytes: meta.bytes, refPresent: typeof meta.ref === 'string' && Boolean(meta.ref) }; }) } : {}) })),
          logEpoch: snapshot.logEpoch, totalCount: snapshot.rows.totalCount, firstRowId: snapshot.rows.firstRowId,
          backgroundWorks: snapshot.backgroundWorks, pendingInteractionIds: Array.isArray(snapshot.pendingInteractions) ?
            snapshot.pendingInteractions.map(value => { const p = record(value); return { interactionId: p.interactionId, kind: p.kind }; }) : undefined });
        if (!s.lifecycle) {
          s.lifecycle = new SessionLifecycle(s.threadId, s.id, snapshot.logEpoch, g, warning(s.threadId),
            message => { if (current(s, g)) io.send(message); }, () => s.child.close(), s.cwd,
            s.backgroundTaskStore);
          s.lifecycle.baseline(snapshot);
        }
        project(s);
      }
    } else if (m.method === 'interaction/requestUserInput' && (typeof m.id === 'string' || typeof m.id === 'number')) {
      const question = nativeQuestion(m.params);
      if (question.sessionId !== s.id) throw new Error('Question session identity mismatch');
      if (s.questions.has(question.requestId) || s.interactions.inspect(question.requestId, g)) return;
      if (s.questions.size) throw new Error('Concurrent questions unsupported');
      s.interactions.observe(question.requestId, g);
      const bbId = `zcode-question:${g}:${randomUUID()}`;
      s.questions.set(question.requestId, { rpcId: m.id, bbId, question, sent: false });
      flushQuestions(s);
    } else if (typeof m.method === 'string' && 'id' in m) {
      // Unexpected full-mode approvals and unsupported questions stay visible;
      // never silently approve.
      s.child.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Unsupported native interaction' } });
      send('error', { threadId: s.threadId, message: 'Unsupported native interaction; stop and inspect diagnostics' });
      services.observe?.({ event: 'unsupported-native-interaction', threadId: s.threadId,
        permission: m.method === 'interaction/requestPermission', autoAllow: false });
    }
  }
  async function command(s: Session, type: string, payload: unknown, commandId = randomUUID()): Promise<Record<string, unknown>> {
    const ack = record(await s.child.request('v4/command', { commandId, clientId: 'bb-zcode',
      sessionId: type === 'createSession' ? null : s.id, type, payload, issuedAt: Date.now() }));
    if (typeof ack.memoryEnabled === 'boolean') services.observe?.({ event: 'native-command-memory',
      threadId: s.threadId, sessionId: s.id, commandId, type, memoryEnabled: ack.memoryEnabled });
    if (ack.status !== 'accepted') {
      const error = new Error('Native command rejected; not sent again') as Error & { rejected: boolean };
      error.rejected = true; throw error;
    }
    return ack;
  }
  async function compactInput(s: Session, clientRequestId: string, instructions: string): Promise<Record<string, never>> {
    if (s.closing || s.detached) throw Error('Native session is not active');
    const snapshot = s.state.snapshot;
    if (!snapshot) throw Error('Native execution state is unknown');
    const execution = inspectExecution(snapshot, warning(s.threadId));
    if (!execution.known) throw Error('Native execution state is unknown');
    if (instructions && (execution.active || execution.waiting)) throw Error('Compaction with instructions requires an idle native session. Stop or wait, then select /compact again.');
    await s.beforeInput?.();
    await s.refreshAuth?.(s.child);
    if (!current(s, s.generation) || s.closing) throw Error('Native session stopped before compact');
    const id = randomUUID(); s.compactions.begin(id, clientRequestId);
    services.observe?.({ event: 'compact-requested', threadId: s.threadId, sessionId: s.id, commandId: id,
      clientRequestId, path: instructions ? 'session/compact' : 'v4/command', instructionLength: instructions.length });
    try {
      if (instructions) {
        const result = record(await s.child.request('session/compact', { sessionId: s.id, inputId: id, instructions }));
        const compact = record(result.compact);
        if (compact.state !== 'accepted' || compact.inputId !== id) throw Error('Native compact admission was not confirmed; not sent again');
      } else await command(s, 'compact', {}, id);
    } catch (error) { s.compactions.reject(id); throw error; }
    if (!current(s, s.generation) || s.closing) throw Error('Native session stopped before compact ACK; reconcile before retry');
    s.compactions.accept(id);
    services.observe?.({ event: 'compact-ack-accepted', threadId: s.threadId, commandId: id, clientRequestId, ownership: 'native' });
    if (s.state.snapshot) s.compactions.project(s.state.snapshot);
    return {};
  }
  async function waitSnapshot(s: Session): Promise<void> {
    const end = Date.now() + 20_000;
    while (!s.state.snapshot) { if (!current(s, s.generation) || Date.now() > end) throw new Error('Native snapshot unavailable'); await delay(20); }
  }
  async function mentionInput(s: Session, input: readonly unknown[], clientRequestId: string) {
    if (!s.knowledge.started && s.skillRoots.length && s.mentionCatalogue) {
      s.bbSkills = bbOnlySkills(s.skillRoots, await s.mentionCatalogue('skills')).skills;
    } else if (s.knowledge.started) s.bbSkills = s.knowledge.skills;
    const selections = selectedMentions(input);
    const catalogues = s.mentionCatalogues; let skills: unknown;
    const converted = await convertMentions(input, async m => {
      const bbSkill = m.source === 'skill' && s.bbSkills.find(skill => skill.name === m.name);
      if (bbSkill) return { name: bbSkill.name, path: bbSkill.path, source: 'skill', origin: m.origin, loadWith: 'file' as const };
      if (!s.mentionCatalogue) throw Error('Native mention catalogue unavailable');
      const side = m.source === 'skill' ? 'skills' : 'commands';
      const started = performance.now(), hit = catalogues.has(side);
      if (!hit) catalogues.set(side, s.mentionCatalogue(side));
      const pending = catalogues.get(side)!;
      let catalogue: unknown;
      try { catalogue = await pending; }
      catch (error) {
        // A transient CLI failure must not poison later mentions in this session.
        if (catalogues.get(side) === pending) catalogues.delete(side);
        throw error;
      }
      services.observe?.({ event: 'mention-catalogue', threadId: s.threadId, sessionId: s.id, side, hit, elapsedMs: performance.now() - started });
      if (side === 'skills' && skills === undefined) skills = await s.child.request('skills/referenceCatalog',
        { sessionId: s.id, workspace: { workspacePath: s.cwd, workspaceKey: s.cwd } });
      return resolveMentionTarget(m, catalogue, skills);
    });
    if (selections.length) services.observe?.({ event: 'mention-input', threadId: s.threadId, sessionId: s.id, clientRequestId,
      selections, targets: converted.targets });
    return converted.input;
  }
  async function attach(p: Record<string, unknown>, resume: boolean): Promise<unknown> {
    const threadId = string(p.threadId), cwd = string(p.cwd), options = record(p.options);
    services.observe?.({ event: 'thread-construction-fields', threadId, resume, fields: Object.keys(p),
      optionFields: Object.keys(options), envNames: Object.keys(record(options.envVars ?? {})),
      providerOptionFields: Object.keys(record(options.providerOptions ?? {})),
      dynamicToolCount: Array.isArray(p.dynamicTools) ? p.dynamicTools.length : 0 });
    const execution = currentExecution(options, String(p.instructionMode), p.disallowedTools);
    if (!threadId.trim()) throw new Error('Canonical thread identity required');
    if (execution.envVars.BB_THREAD_ID !== undefined && execution.envVars.BB_THREAD_ID !== threadId)
      throw new Error('Environment thread identity conflict');
    if (sessions.has(threadId)) throw new Error('Thread already attached');
    if (!resume && createdIdentities.has(threadId)) throw new Error('Created native identity requires recovery/resume; no duplicate create');
    const setup = await services.prepare(cwd, execution, { threadId, ...(resume ? { providerThreadId: string(p.providerThreadId) } : {}) });
    Object.assign(execution, await services.validateSelection(execution.model, execution.reasoning, execution.authMode, execution.catalogueRefresh));
    const { model, reasoning } = execution;
    if (closing) throw new Error('Bridge is shutting down; resume required');
    const g = ++generation;
    const s: Session = { threadId, cwd, model, reasoning, id: resume ? string(p.providerThreadId) : '', generation: g,
      auth: setup.auth, refreshAuth: setup.refreshAuth, beforeInput: setup.beforeInput, state: new ConversationState(warning(threadId)), decoder: new FrameDecoder(warning(threadId)),
      lifecycle: null, correlation: new CommandCorrelation(), detached: false, closing: false, subscription: null,
      options: execution.signature, construction: { ...p }, memoryEnabled: execution.memoryEnabled, instructionMode: String(p.instructionMode), timers: new Map(),
      interactions: new InteractionArbiter(), questions: new Map(), steerRequests: new Set(),
      compactions: new CompactionProjection(deltas => send('thread/delta', { threadId, deltas: deltas.map(d => threadDeltaSchema.parse(d)) }), pluginId + '/compaction'),
      mentionCatalogue: setup.mentionCatalogue, backgroundTaskStore: setup.backgroundTaskStore, knowledgeStore: setup.knowledgeStore,
      knowledge: new SessionKnowledge(setup.knowledgeStore), skillRoots: structuredClone(skillRoots), bbSkills: [],
      mentionCatalogues: new Map(), child: null as unknown as NativeProcess };
    sessions.set(threadId, s);
    try {
      s.child = new NativeProcess(setup.launch, g, threadId, (m, gen) => {
        try { nativeMessage(s, m, gen); } catch { void died(s, new Error('Native projection failed; reconcile before retry'), gen); }
      }, (error, gen) => { void died(s, error, gen).catch(() => {
        services.observe?.({ event: 'native-death-cleanup-unresolved', threadId: s.threadId, generation: gen });
        send('error', { threadId: s.threadId, providerThreadId: s.id, message: 'Owned native cleanup unresolved; recovery required' });
      }); });
      await setup.configure(s.child);
      if (!resume) {
        setup.markCreatePending?.();
        const snapshot = record(await s.child.request('session/create', {
          workspace: { workspacePath: cwd, workspaceKey: cwd }, mode: 'yolo', persistence: 'deferred',
          titleGenerationEnabled: false, toolDenylist: execution.toolDenylist }));
        s.id = string(record(snapshot.session).sessionId);
        createdIdentities.set(threadId, s.id);
        send('thread/identity', { threadId, providerThreadId: s.id });
        setup.bindSession?.(s.id);
      }
      if (resume) {
        // A new process has no resident session. Apply options before V4
        // subscribe can load a resident with the native default tool set.
        await s.child.request('session/resume', { sessionId: s.id,
          workspace: { workspacePath: cwd, workspaceKey: cwd }, toolDenylist: execution.toolDenylist });
        send('thread/identity', { threadId, providerThreadId: s.id });
      }
      services.observe?.({ event: 'session-tool-denylist', threadId, sessionId: s.id, resume, toolDenylist: execution.toolDenylist });
      send('thread/delta', { threadId, deltas: [{ kind: 'session.reset' }] });
      const compatibilityMessage = services.compatibilityWarning ? services.compatibilityWarning() : services.compatibility?.().message;
      if (compatibilityMessage) send('thread/delta', { threadId, deltas: [{ kind: 'provider.warning', category: 'general', summary: compatibilityMessage }] });
      await s.child.request('v4/conversation/subscribe', { topic: `conversation/${s.id}`, connectionId: randomUUID(),
        clientMode: 'desktop-continuous', workspace: { workspacePath: cwd, workspaceKey: cwd } });
      await waitSnapshot(s);
      await setup.readySession?.(s.child, s.id);
      for (const summary of setup.warnings ?? []) send('thread/delta', { threadId,
        deltas: [{ kind: 'provider.warning', category: 'general', summary }] });
      return { providerThreadId: s.id };
    } catch (e) {
      if (s.id) send('error', { threadId, providerThreadId: s.id, message: 'Native attach failed; preserve identity and reconcile binding before retry' });
      closePending(s);
      if (s.child) await s.child.close(); s.detached = true; sessions.delete(threadId); throw e;
    }
  }
  async function died(s: Session, error: Error, g: number): Promise<void> {
    if (!current(s, g) || s.closing) return;
    s.closing = true;
    cancelQuestions(s);
    closePending(s);
    try {
      s.compactions.settle('failed');
      if (s.lifecycle) await s.lifecycle.processDied(g, s.id, s.correlation);
      send('error', { threadId: s.threadId, providerThreadId: s.id, message: error.message });
    } finally { await s.child.close(); s.detached = true; }
  }
  function stop(s: Session, intent: 'interrupt' | 'release'): Promise<void> {
    return s.stopping ??= stopOwned(s, intent);
  }
  async function stopOwned(s: Session, intent: 'interrupt' | 'release'): Promise<void> {
    s.closing = true;
    cancelQuestions(s);
    closePending(s);
    s.compactions.settle('interrupted');
    if (!s.detached) {
      // Actual ownership is settled by group cleanup. Native stop is best effort,
      // bounded independently of60s general RPC timeout; no prompt is sent.
      const snapshot = s.state.snapshot;
      const fg = snapshot?.control && record(snapshot.control).activeWorks;
      const works = Array.isArray(fg) ? fg : [];
      const active = works.find(w => typeof record(w).foregroundExecutionId === 'string');
      if (active && intent === 'interrupt') await Promise.race([command(s, 'stop', { expectedForegroundExecutionId: record(active).foregroundExecutionId }).catch(() => {}), delay(1000)]);
      const background = Array.isArray(snapshot?.backgroundWorks) ? snapshot.backgroundWorks : [];
      const cancellations = background.filter(w => ['running', 'resultPending'].includes(String(record(w).status)))
        .map(w => {
          const value = record(w).workId;
          if (typeof value !== 'string' || !value.trim()) {
            services.observe?.({ event: 'background-cancel-unconfirmed', threadId: s.threadId, sessionId: s.id, reason: 'missing-work-identity' });
            return Promise.resolve();
          }
          const workId = value;
          return command(s, 'cancelBackgroundWork', { workId }).then(() => {
            services.observe?.({ event: 'background-cancel-ack', threadId: s.threadId, sessionId: s.id, workId });
          }).catch(() => {
            services.observe?.({ event: 'background-cancel-unconfirmed', threadId: s.threadId, sessionId: s.id, workId });
          });
        });
      if (cancellations.length) await Promise.race([Promise.all(cancellations), delay(1000)]);
      if (s.lifecycle) await s.lifecycle.stop(intent, s.generation, s.id, s.correlation);
      else if (await s.child.close()) throw new Error('Owned native process group remains');
    } else if (await s.child.close()) throw new Error('Owned native process group remains');
    services.observe?.({ event: 'stop-settled-probes', threadId: s.threadId, sessionId: s.id,
      pid: s.child.child.pid, nativePid: s.child.nativePid, probes: s.child.cleanupObservations,
      foreground: s.state.snapshot?.control, backgroundWorkIds: Array.isArray(s.state.snapshot?.backgroundWorks) ?
        (s.state.snapshot!.backgroundWorks as unknown[]).map(w => record(w).workId).filter(id => typeof id === 'string') : [] });
    s.detached = true; sessions.delete(s.threadId);
  }
  async function dispatch(method: string, value: unknown): Promise<unknown> {
    if (closing) throw new Error('Bridge is shutting down; resume required');
    if (method === 'initialize') { initializeParamsSchema.parse(value); return { protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION, capabilities: bridgeCapabilities }; }
    if (method === 'skills/configure') {
      skillRoots = structuredClone(skillsConfigureParamsSchema.parse(value).roots);
      for (const s of sessions.values()) if (!s.knowledge.started) s.skillRoots = structuredClone(skillRoots);
      return { ok: true };
    }
    if (method === 'provider/health') return services.health(authMode(record(record(value).providerOptions ?? {}).authMode));
    if (method === 'provider/installation/status') return services.installation();
    if (method === 'provider/installation/run') return { available: false, message: 'Install ZCode Desktop yourself; no automatic updates' };
    if (method === 'model/list') {
      const p = modelListParamsSchema.parse(value), options = record(p.providerOptions ?? {});
      const refresh = options.catalogueRefresh ?? 0;
      if (!Number.isSafeInteger(refresh) || Number(refresh) < 0) throw new Error('Invalid catalogue refresh');
      const result = record(await services.models(p.cwd, authMode(options.authMode), Number(refresh)));
      return { ...result, selectedOnlyModels: [] };
    }
    if (method === 'thread/start') return attach(threadStartParamsSchema.parse(value), false);
    if (method === 'turn/steer') {
      const p = turnSteerParamsSchema.parse(value), s = sessions.get(p.threadId);
      if (!s || s.closing || s.detached || s.id !== p.providerThreadId) throw new Error('Native session is not active');
      const snapshot = s.state.snapshot;
      if (!snapshot) throw new Error('Native active turn is unknown');
      const execution = inspectExecution(snapshot, warning(s.threadId));
      const active = snapshot.rows.window.filter(r => r.kind === 'turnHeader' && r.state === 'running');
      if (!execution.known || !execution.foregroundActive || active.length !== 1 || active[0]!.turnId !== p.expectedTurnId)
        throw new Error('Native active turn does not match expectedTurnId');
      const compact = compactSelection(p.input);
      if (compact) return compactInput(s, p.clientRequestId, compact.instructions);
      // Like Codex, steer keeps the active turn's execution settings. New
      // composer options take effect on the next ordinary turn/start.
      const options = { ...executionOptions(s.construction.options, s.instructionMode, s.construction.disallowedTools),
        model: s.model, reasoning: s.reasoning, authMode: s.auth.source() };
      if (s.steerRequests.has(p.clientRequestId)) throw new Error('Duplicate steer request');
      const converted = convertAttachments(await mentionInput(s, p.input, p.clientRequestId), s.cwd);
      if (converted.attachments.some(a => a.kind === 'image')) {
        const models = record(await services.models(s.cwd, options.authMode, options.catalogueRefresh)).models;
        requireImageCapability(Array.isArray(models) ? models : [], options.model);
      }
      await s.beforeInput?.();
      await s.refreshAuth?.(s.child);
      const refs = await createAttachmentRefs(converted.attachments, s.id, (method, params) => s.child.request(method, params));
      if (!current(s, s.generation) || s.closing) throw new Error('Native session stopped before steer');
      // Completion after validation is allowed to admit an ordinary native turn.
      // Never use startNow or put an ACKed input in another BB queue.
      const id = randomUUID(); s.steerRequests.add(p.clientRequestId);
      services.observe?.({ event: 'steer-requested', threadId: s.threadId, sessionId: s.id, commandId: id,
        clientRequestId: p.clientRequestId, expectedTurnId: p.expectedTurnId, requestedDelivery: 'guide', attachments: converted.metadata,
        model: options.model, reasoning: options.reasoning, authSource: options.authMode,
        composerModel: p.options.model, composerReasoning: p.options.reasoningLevel });
      const ack = await command(s, 'sendText', { text: converted.text, ...(refs.length ? { attachments: refs } : {}),
        requestedDelivery: 'guide', mode: 'yolo', planEnabled: false,
        modelSelection: { providerId: accountProviderId, modelId: options.model, options: { reasoningLevel: options.reasoning } } }, id);
      const admitted = record(ack.result);
      if (admitted.type !== 'inputAccepted' || admitted.inputId !== id || !['queue', 'startNow'].includes(String(admitted.delivery)))
        throw new Error('Native steer ACK identity is unconfirmed; not sent again');
      if (!current(s, s.generation) || s.closing) throw new Error('Native session stopped before steer ACK');
      io.send({ jsonrpc: '2.0', method: 'thread/delta', params: { threadId: s.threadId,
        deltas: [threadDeltaSchema.parse({ kind: 'input.accepted', clientRequestId: p.clientRequestId, providerTurnId: p.expectedTurnId })] } });
      services.observe?.({ event: 'steer-ack-accepted', threadId: s.threadId, commandId: id, clientRequestId: p.clientRequestId,
        providerTurnId: p.expectedTurnId, ownership: 'native' });
      return {};
    }
    if (method === 'thread/resume') return attach(threadResumeParamsSchema.parse(value), true);
    if (method === 'thread/stop' || method === 'thread/discard') {
      const p = method === 'thread/stop' ? threadStopParamsSchema.parse(value) : threadDiscardParamsSchema.parse(value);
      const s = sessions.get(p.threadId);
      if (s && s.id !== p.providerThreadId) throw new Error('Session identity mismatch');
      if (s) await stop(s, 'intent' in p && p.intent === 'interrupt' ? 'interrupt' : 'release');
      return {};
    }
    if (method === 'turn/start') {
      const p = turnStartParamsSchema.parse(value); let s = sessions.get(p.threadId);
      if (!s || s.detached || s.id !== p.providerThreadId) throw new Error('Resume required; no automatic context replacement');
      const compact = compactSelection(p.input);
      if (compact) return compactInput(s, p.clientRequestId, compact.instructions);
      selectedMentions(p.input); // Unsupported selection fails before reconfiguration.
      const previous = record(s.construction.options);
      const reconciledOptions = { ...p.options, envVars: p.options.envVars === undefined ? previous.envVars ?? {} : p.options.envVars };
      const execution = currentExecution(reconciledOptions, s.instructionMode, s.construction.disallowedTools);
      if (execution.envVars.BB_THREAD_ID !== undefined && execution.envVars.BB_THREAD_ID !== p.threadId)
        throw new Error('Environment thread identity conflict');
      Object.assign(execution, await services.validateSelection(execution.model, execution.reasoning, execution.authMode, execution.catalogueRefresh));
      if (execution.signature !== s.options) {
        const construction = s.construction, id = s.id, before = s.state.snapshot;
        await stop(s, 'release');
        // Same persisted native session, fresh launch options. No create fallback.
        await attach({ ...construction, options: reconciledOptions, providerThreadId: id }, true);
        s = sessions.get(p.threadId)!;
        const after = s.state.snapshot;
        // v4-gateway defaultLogEpoch is publisher/process-local, not durable
        // history identity. A new epoch alone cannot mean context loss.
        const retained = retainedRows(before, after);
        services.observe?.({ event: 'replacement-retention', threadId: s.threadId, sessionId: s.id,
          beforeEpoch: before?.logEpoch, afterEpoch: after?.logEpoch, beforeRows: before?.rows.totalCount,
          afterRows: after?.rows.totalCount, retained, difference: retentionDifference(before, after),
          scope: 'semantic visible native rows including unknown fields, not full cold context proof' });
        send('session/replaced', { threadId: s.threadId, providerThreadId: s.id,
          reason: 'Launch settings changed; the same native session was resumed. Memory and subagent changes apply to this ordinary turn; steering keeps active settings.',
          contextLost: false, showRuntimeNote: true });
      }
      // Source selection is per turn, never a credential in launch options.
      s.auth.setMode(execution.authMode);
      const previousExecution = executionOptions(previous, s.instructionMode, s.construction.disallowedTools);
      if (execution.authMode !== previousExecution.authMode || execution.catalogueRefresh !== previousExecution.catalogueRefresh ||
          execution.model !== s.model || execution.reasoning !== s.reasoning) s.mentionCatalogues.clear();
      try { await s.beforeInput?.(); } catch (error) { await stop(s, 'release'); throw error; }
      await s.refreshAuth?.(s.child);
      if (s.knowledge.needsReconcile) {
        const history = record(await s.child.request('session/messages', { sessionId: s.id }));
        if (!Array.isArray(history.messages)) throw Error('Native active history unavailable after compaction');
        const retained = s.knowledge.reconcile(history.messages);
        services.observe?.({ event: 'bb-knowledge-compaction-reconciled', threadId: s.threadId, sessionId: s.id, retained });
      }
      s.construction = { ...s.construction, options: reconciledOptions };
      const converted = convertAttachments(await mentionInput(s, p.input, p.clientRequestId), s.cwd);
      if (converted.attachments.some(a => a.kind === 'image')) {
        const models = record(await services.models(s.cwd, execution.authMode, execution.catalogueRefresh)).models;
        requireImageCapability(Array.isArray(models) ? models : [], execution.model);
      }
      const attachmentRefs = await createAttachmentRefs(converted.attachments, s.id, (method, params) => s.child.request(method, params));
      const id = randomUUID(); s.correlation.begin(id, p.clientRequestId, s.generation, Date.now() + 60_000);
      const pendingSession = s, pendingGeneration = s.generation;
      const unresolved = setTimeout(() => {
        if (current(pendingSession, pendingGeneration) && ['pending', 'unknown'].includes(pendingSession.correlation.status(id) ?? '')) {
          pendingSession.correlation.expire(Date.now());
          send('error', { threadId: pendingSession.threadId, message: 'Native input identity unresolved; reconcile before retry. The native process remains available; this input was not sent again.' });
        }
      }, 60_000); unresolved.unref();
      s.timers.set(id, unresolved);
        services.observe?.({ event: 'turn-requested-selection', threadId: s.threadId, sessionId: s.id, commandId: id,
        pid: s.child.child.pid, model: execution.model, reasoning: execution.reasoning });
      try {
        s.model = execution.model;
        s.reasoning = execution.reasoning;
        s.child.activity('active');
        services.observe?.({ event: 'attachment-input', threadId: s.threadId, sessionId: s.id, commandId: id, model: execution.model, attachments: converted.metadata });
        if (!s.knowledge.started && s.skillRoots.length) {
          const catalogue = s.mentionCatalogue ? await s.mentionCatalogue('skills') : { skills: [] };
          const resolved = bbOnlySkills(s.skillRoots, catalogue); s.bbSkills = resolved.skills;
          services.observe?.({ event: 'bb-skills-resolved', threadId: s.threadId, sessionId: s.id, ...resolved });
        }
        const block = [execution.instructions ? '[bb session instructions]\n' + execution.instructions : '', skillsBlock(s.bbSkills)].filter(Boolean).join('\n\n');
        const text = s.knowledge.prepare(id, block, converted.text, s.bbSkills);
        await command(s, 'sendText', { text, ...(attachmentRefs.length ? { attachments: attachmentRefs } : {}), requestedDelivery: 'startNow', mode: 'yolo', planEnabled: false,
          modelSelection: { providerId: accountProviderId, modelId: execution.model, options: { reasoningLevel: execution.reasoning } } }, id);
      } catch (e) {
        if ((e as { rejected?: boolean }).rejected) {
          s.knowledge.rejected(id);
          s.correlation.authoritative(id, s.generation, 'rejected');
          services.observe?.({ event: 'pending-closed', threadId: s.threadId, commandId: id, outcome: 'rejected' });
        }
        if (!(e instanceof NativeRequestTimeout)) await stop(s, 'release');
        throw e;
      }
      s.correlation.ack(id, s.generation);
      // ACK delivery/inputId/optional schema messageId are not authoritative
      // turn identity. project binds sourceCommandId -> turnHeader.turnId only.
      project(s); return {};
    }
    const e = new Error('Method not found') as Error & { code: number }; e.code = -32601; throw e;
  }
  const handleLine = createBridgeLineHandler({ handleParsedMessage(message) {
    // Reverse RPC responses bypass the per-thread request queue and have no
    // timeout: questions wait for a human or stop. Removed IDs are tombstones.
    if (message && typeof message === 'object' && !('method' in message) && 'id' in message) {
      const response = record(message), bbId = response.id;
      if (typeof bbId !== 'string') return;
      const s = questionResponses.get(bbId);
      if (!s || !current(s, s.generation) || s.closing) return;
      const entry = [...s.questions].find(([, p]) => p.bbId === bbId);
      if (!entry) return;
      const [id, pending] = entry;
      try {
        if ('error' in response) throw new Error('Question delivery failed');
        const answer = nativeAnswer(pending.question, response.result);
        if (!s.interactions.propose(id, s.generation, 'reverseRpc', answer)) return;
        questionResponses.delete(bbId); s.questions.delete(id);
        s.child.write({ jsonrpc: '2.0', id: pending.rpcId, result: answer });
        services.observe?.({ event: 'question-response-dispatched', threadId: s.threadId, sessionId: s.id,
          requestId: id, bbId, generation: s.generation, action: answer.action });
      } catch {
        services.observe?.({ event: 'question-response-failed', threadId: s.threadId, requestId: id, generation: s.generation });
        send('error', { threadId: s.threadId, message: 'Question delivery or response failed; stop and reconcile before retry' });
        void stop(s, 'release').catch(() => send('error', { threadId: s.threadId, message: 'Owned cleanup unresolved; recovery required' }));
      }
      return;
    }
    const parsed = bridgeRequestEnvelopeSchema.safeParse(message);
    if (!parsed.success) return;
    const request = parsed.data;
    runBridgeRequest({ request, sendError: (id, code, msg, data) => io.sendError(id, code, msg, data),
      handleRequest: async r => {
        const key = r.params && typeof r.params === 'object' && 'threadId' in r.params ? String(r.params.threadId) : null;
        // Stop must be able to cut an outstanding turn/request; other per-thread
        // construction/mutation operations serialize without cross-thread locks.
        const task = async () => {
          const wholeStop = r.method === 'thread/stop' && key;
          if (wholeStop) services.observe?.({ event: 'whole-stop-request', threadId: key, rpcId: r.id });
          const questionStop = r.method === 'thread/stop' && key && Boolean(sessions.get(key)?.questions.size);
          if (questionStop) services.observe?.({ event: 'question-stop-request', threadId: key, rpcId: r.id });
          try {
            const result = await dispatch(r.method, r.params);
            // Pre-write result boundary: an exit before this observation is
            // necessarily before the UI-triggered stop RPC reply as well.
            if (questionStop) services.observe?.({ event: 'question-stop-result-dispatch', threadId: key, rpcId: r.id });
            if (wholeStop) services.observe?.({ event: 'whole-stop-result-dispatch', threadId: key, rpcId: r.id });
            io.sendResult(r.id, result);
          }
          catch (e) {
            if (e instanceof AuthError && e.kind === 'unauthenticated') throw authRecovery();
            if (e instanceof UnsupportedPlanError) {
              if (key) send('thread/delta', { threadId: key, deltas: [threadDeltaSchema.parse({ kind: 'provider.error', category: 'bad-request', message: e.message })] });
              io.sendError(r.id, -32602, e.message); return;
            }
            if (e instanceof MissingExecutableError) { io.sendError(r.id, -32004, e.message); return; }
            if ((e as Error).name === 'ZodError') { io.sendError(r.id, -32602, 'Invalid params'); return; }
            const code = (e as { code?: number }).code;
            if (code === -32601) { io.sendError(r.id, code, 'Method not found'); return; }
            // Keep the actual failure object/kind/code. Compatibility adds
            // context only; it never converts failure into unsupported/success.
            const context = services.compatibility?.().message;
            if (context && e instanceof Error) e.message += ' ' + context;
            throw e;
          }
        };
        if (key && r.method !== 'thread/stop' && r.method !== 'thread/discard') {
          const previous = operations.get(key) ?? Promise.resolve();
          const next = previous.catch(() => {}).then(task); operations.set(key, next);
          try { await next; } finally { if (operations.get(key) === next) operations.delete(key); }
        } else await task();
      } });
  } });
  return { handleLine, setPluginId(id: string) {
    if (sessions.size || !/^[a-z0-9-]+$/u.test(id)) throw Error('Invalid bridge plugin identity');
    pluginId = id;
  }, close() {
    return closing ??= (async () => {
      const outcomes = await Promise.allSettled([...sessions.values()].map(s => stop(s, 'interrupt')));
      if (outcomes.some(v => v.status === 'rejected')) {
        for (const s of sessions.values()) send('error', { threadId: s.threadId, providerThreadId: s.id,
          message: 'Owned cleanup unresolved during bridge shutdown; recovery required' });
        // Preserve the typed cleanup cause; the public diagnostic above is fixed.
        throw outcomes.find(v => v.status === 'rejected')!.reason;
      }
    })();
  },
    ownedPids: () => [...sessions.values()].map(s => s.child.child.pid).filter(Boolean) };
}
