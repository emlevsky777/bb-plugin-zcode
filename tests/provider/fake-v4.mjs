// Own synthetic V4 child. Field vocabulary follows pinned snapshot.ts and
// accepted1.1 control-states; this is no evidence of native execution.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync, closeSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
let [mode = 'v4', file] = process.argv.slice(2);
if (mode === 'app-server') { mode = 'v4'; file = join(process.env.HOME, 'fake-native-sessions.json'); }
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
if (mode === 'crash') { process.stderr.write('SYNTHETIC_SECRET_DO_NOT_RECORD\n'); setTimeout(() => process.exit(7), 60); }
if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdin.resume(); }
if (mode === 'epipe') { closeSync(0); process.stdout.write(JSON.stringify({ method: 'fixture/epipe-ready' }) + '\n'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
if (mode === 'descendant') { spawn(process.execPath, [import.meta.filename, 'hang'], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env }); setTimeout(() => process.exit(0), 50); }
if (mode === 'changed-orphan') {
  process.on('SIGTERM', () => {}); process.stdin.resume();
  setInterval(() => { if (process.ppid === 1) process.title = 'm2-unverified-own'; }, 10);
}
if (['detached-descendant', 'detached-changing'].includes(mode)) {
  const owned = spawn(process.execPath, [import.meta.filename, mode === 'detached-changing' ? 'changed-orphan' : 'hang', file], { detached: true, stdio: 'ignore', env: process.env });
  owned.unref(); writeFileSync(file + '.ready-tmp', JSON.stringify({ pid: owned.pid }), 'utf8');
  renameSync(file + '.ready-tmp', file);
  process.stdin.resume(); process.stdin.on('end', () => process.exit(0));
}
if (mode === 'v4') {
  let sessions = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  let id, subscription, seq = 0;
  let question, permission;
  const persist = () => { if (file) writeFileSync(file, JSON.stringify(sessions), 'utf8'); };
  const initial = () => ({ logEpoch: 'fake-epoch', rows: { window: [], totalCount: 0, firstRowId: null }, control: { phase: 'draft', activeWorks: [] }, backgroundWorks: [], pendingInteractions: [] });
  function frame() {
    const snapshot = sessions[id];
    const f = { topic: 'conversation/' + id, subscriptionId: subscription, fromSeq: seq, toSeq: ++seq, payload: { kind: 'snapshot', snapshot } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'v4/conversation/frame', params: { wireVersion: 3, kind: 'complete', topic: f.topic,
      subscriptionId: subscription, logicalFrameId: randomUUID(), logicalFrameOrdinal: seq, frame: f } }) + '\n');
  }
  function compact(commandId, instructions) {
    const s = sessions[id];
    s.compactCommands = [...(s.compactCommands ?? []), { commandId, instructions }];
    const turnId = 'compact-' + commandId;
    const header = { rowId: ++s.rows.totalCount, kind: 'turnHeader', turnId, sourceCommandId: commandId, state: 'running' };
    s.rows.window.push(header);
    const marker = { rowId: ++s.rows.totalCount, kind: 'timelineMarker', turnId, sourceCommandId: commandId,
      marker: { type: 'compact', origin: 'manual', status: 'running' } };
    s.rows.window.push(marker); s.rows.firstRowId ??= marker.rowId;
    persist(); frame();
    setTimeout(() => { marker.marker.status = instructions === 'noop' ? 'noop' : instructions === 'fail' ? 'failed' : 'success'; header.state='completedSuccess'; persist(); frame(); frame(); }, 80);
  }
  createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line), p = m.params;
    if (permission && m.id === permission && !m.method) {
      sessions[id].permissionResponse = m;
      persist(); permission = undefined; return;
    }
    if (question && m.id === question.id && !m.method) {
      const s = sessions[id];
      s.pendingInteractions = [];
      s.control = { phase: m.result?.action === 'accept' ? 'completedSuccess' : 'completedInterrupted', activeWorks: [] };
      for (const r of s.rows.window.filter(r => r.turnId === question.turnId))
        if (r.kind === 'turnHeader') r.state = s.control.phase;
        else if (r.kind === 'toolCall') r.status = m.result?.action === 'accept' ? 'success' : 'cancelled';
        else if (r.kind === 'assistantText') { r.state = 'complete'; r.text = JSON.stringify(m.result); }
      s.questionDispatches = (s.questionDispatches ?? 0) + 1;
      persist(); frame(); question = undefined; return;
    }
    // pinned zcode-protocol/index.ts: request/response/notification are strict
    // and contain no jsonrpc marker. Do not repeat the creator's wire mistake.
    if (Object.keys(m).some(k => !['id', 'method', 'params', 'result', 'error'].includes(k))) {
      process.stdout.write(JSON.stringify({ id: 'invalid-message', error: { code: -32600, message: 'Strict native envelope' } }) + '\n'); return;
    }
    if (m.method === 'runtime/capabilities') reply(m.id, {});
    else if (m.method === 'v4/conversation/subscribe') {
      id = p.topic.slice('conversation/'.length); subscription = randomUUID(); seq = 0;
      if (!sessions[id]) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'not found' } }) + '\n'); return; }
      // v4-gateway defaultLogEpoch is recreated by each publisher/child.
      sessions[id].logEpoch = randomUUID();
      frame(); reply(m.id, { subscriptionId: subscription });
    } else if (m.method === 'v4/command') {
      if (p.type === 'createSession') {
        id = 'sess_' + randomUUID(); sessions[id] = initial(); sessions[id].config = p.payload.config; persist();
        reply(m.id, { status: 'accepted', result: { type: 'createSession', sessionId: id } });
      } else if (p.type === 'compact') {
        const s = sessions[id];
        if (s.rows.window.some(r => r.marker?.status === 'running')) { reply(m.id, { status: 'rejected' }); return; }
        compact(p.commandId, ''); reply(m.id, { status: 'accepted', result: { type: 'compact' } });
      } else if (p.type === 'sendText') {
        if (p.payload.requestedDelivery === 'guide') {
          const s = sessions[id], active = s.rows.window.find(r => r.kind === 'turnHeader' && r.state === 'running');
          s.steerCommands = [...(s.steerCommands ?? []), p]; persist();
          if (p.payload.text === '/steer-reject') {
            reply(m.id, { status: 'rejected' }); return;
          }
          if (p.payload.text === '/steer-wrong-ack') {
            reply(m.id, { status: 'accepted', result: { type: 'inputAccepted', delivery: 'queue', inputId: 'wrong' } }); return;
          }
          const queued = p.payload.text === '/steer-queue' || p.payload.text === '/steer-boundary';
          reply(m.id, { status: 'accepted', result: { type: 'inputAccepted', delivery: 'queue', inputId: p.commandId } });
          if (queued) {
            for (const r of s.rows.window) if (r.kind === 'turnHeader') r.state = 'completedSuccess';
            const turnId = randomUUID();
            s.rows.window.push({ rowId: ++s.rows.totalCount, kind: 'turnHeader', turnId, state: 'running', sourceCommandId: p.commandId });
          }
          const turnId = queued ? s.rows.window.at(-1).turnId : active.turnId;
          s.rows.window.push({ rowId: ++s.rows.totalCount, kind: 'userInput', turnId, sourceCommandId: p.commandId, text: p.payload.text, origin: 'realUser',
            ...(queued ? {} : { guided: true }), ...(p.payload.attachments ? { attachments: p.payload.attachments } : {}) });
          persist(); frame(); frame();
          setTimeout(() => {
            s.control = { phase: 'completedSuccess', activeWorks: [] };
            for (const r of s.rows.window) if (r.kind === 'turnHeader') r.state = 'completedSuccess';
            persist(); frame(); frame();
          }, 80);
          return;
        }
        const s = sessions[id], text = p.payload.text, turnId = randomUUID(), rowId = s.rows.totalCount + 1;
        s.config = { ...s.config, modelSelection: p.payload.modelSelection };
        const wait = ['/wait-for-interrupt', '/question', '/permission'].includes(text), zero = text === '/clear' || text === '/zero-before-ack';
        // Headerless/messageId cases are synthetic schema diagnostics only.
        const headerless = text === '/synthetic-headerless';
        if (!headerless) {
          s.rows.window.push({ kind: 'turnHeader', rowId, turnId, state: wait ? 'running' : 'completedSuccess', sourceCommandId: p.commandId });
          if (!zero) s.rows.window.push({ kind: 'assistantText', rowId: rowId + 1, turnId, text: 'hello ' + turnId, state: wait ? 'streaming' : 'complete' });
          s.rows.totalCount += zero ? 1 : 2; s.rows.firstRowId ??= rowId;
        }
        s.control = { phase: wait ? 'running' : 'completedSuccess', activeWorks: wait ? [{ kind: 'primaryTurn', foregroundExecutionId: 'fg_' + turnId }] : [] };
        persist();
        if (text === '/zero-before-ack') frame();
        reply(m.id, { status: 'accepted', result: { type: 'inputAccepted', delivery: 'startNow', inputId: p.commandId,
          ...(text === '/synthetic-different-message' || headerless ? { messageId: 'synthetic-not-turn-id' } : {}) } });
        if (text === '/synthetic-different-message') setTimeout(frame, 40);
        else if (text !== '/zero-before-ack') frame();
        if (text === '/question') {
          question = { id: 'native-question-' + turnId, turnId };
          // OSS rows.ts191/snapshot.ts310 + actual M2: distinct namespaces,
          // and the reverse request may precede its pending anchor frame.
          process.stdout.write(JSON.stringify({ id: question.id, method: 'interaction/requestUserInput', params: {
            requestId: question.id, sessionId: id, turnId: 'legacy-' + turnId, toolName: 'AskUserQuestion', toolCallId: 'tool-' + turnId,
            questions: [{ question: 'Which effect?', header: 'Effect', options: [{ value: 'once', label: 'Once' }, { value: 'never', label: 'Never' }] }] } }) + '\n');
          const anchorRowId = ++s.rows.totalCount;
          s.rows.window.push({ kind: 'toolCall', rowId: anchorRowId, turnId, toolCallId: 'tool-' + turnId,
            toolName: 'AskUserQuestion', status: 'pendingApproval', inputText: '{}' });
          s.pendingInteractions = [{ interactionId: question.id, kind: 'userInput', anchorRowId,
            payload: { kind: 'userInput', toolCallId: 'tool-' + turnId } }]; persist(); frame();
        }
        if (text === '/permission') {
          permission = 'permission-' + turnId;
          // OSS zcode-protocol/index.ts2279 and legacy-types.ts65: full native
          // request shape, although full-mode native ordinarily never asks.
          process.stdout.write(JSON.stringify({ id: permission,
            method: 'interaction/requestPermission', params: { requestId: permission, sessionId: id,
              turnId, toolCallId: 'tool-' + turnId, toolName: 'Bash', reason: 'Own offline fixture', riskLevel: 'low',
              input: { command: 'fixture-only' }, options: [{ optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }] } }) + '\n');
        }
      } else if (p.type === 'stop') {
        const s = sessions[id]; s.control = { phase: 'completedInterrupted', activeWorks: [] };
        for (const r of s.rows.window) if (r.state === 'running' || r.state === 'streaming') r.state = r.kind === 'turnHeader' ? 'completedInterrupted' : 'interrupted';
        persist(); frame(); reply(m.id, { status: 'accepted', result: { type: 'stop' } });
      }
    } else if (m.method === 'session/compact') {
      compact(p.inputId, p.instructions); reply(m.id, { compact: { state: 'accepted', inputId: p.inputId } });
    } else if (m.method === 'session/create') {
      id = randomUUID(); sessions[id] = initial(); persist();
      reply(m.id, { session: { sessionId: id }, settings: { model: { current: { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3' }, available: ['GLM-5.3', 'GLM-5.3-Flash'].map(modelId => ({ ref: { providerId: 'account:zai-individual-coding-plan', modelId }, reasoning: { defaultLevel: 'max', levels: ['low','high','max'].map(value => ({ value })) } })) } } });
    } else if (m.method === 'session/read') reply(m.id, { snapshot: { settings: { model: { available: ['GLM-5.3', 'GLM-5.3-Flash'].map(modelId => ({ ref: { providerId: 'account:zai-individual-coding-plan', modelId }, reasoning: { defaultLevel: 'max', levels: ['low', 'high', 'max'].map(value => ({ value })) } })) } } } });
    else if (m.method === 'fixture/complete') {
      const s = sessions[id];
      for (const r of s.rows.window) if (r.kind === 'turnHeader') r.state = 'completedSuccess';
      s.control = { phase: 'completedSuccess', activeWorks: [] }; persist(); frame(); reply(m.id, {});
    }
    else if (m.method === 'echo') reply(m.id, p);
    else if (m.method === 'auth-bad') {
      const fixture = p.fixture ?? {};
      process.stdout.write(JSON.stringify({ id: 'reverse-auth', method: 'interaction/requestProviderRuntimeHeaders', params: {
        providerId: 'account:zai-individual-coding-plan', accountAccess: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai', entitled: true },
        modelSelection: { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3' }, sessionId: id,
        reason: 'model-request', requestId: 'synthetic-request', workspace: { workspacePath: process.cwd(), workspaceKey: process.cwd() }, ...fixture } }) + '\n');
      reply(m.id, {});
    }
  }).on('close', () => process.exit(0));
}
