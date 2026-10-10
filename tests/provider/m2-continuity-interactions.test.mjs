import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api, snapshot, rows } from './helpers.mjs';
const options = { ...JSON.parse(readFileSync(new URL('./fixtures/bb-real-inputs.json', import.meta.url), 'utf8')).fixtures[0].request.params.options, envVars: {} };
const base = resolve(process.env.ZCODE_CONNECTION_TEST_ROOT ?? '.local/M2/offline');
mkdirSync(base, { recursive: true });
async function harness(fn) {
  const cwd = mkdtempSync(base + '/m2-'), output = [], observe = [];
  const services = { prepare: async () => ({ launch: { executable: process.execPath, args: [resolve('tests/provider/fake-v4.mjs'), 'v4', cwd + '/sessions.json'], cwd,
    env: api.childEnvironment(process.env, { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE }) }, auth: new api.ReadOnlyAuth(cwd + '/missing'),
    configure: async p => { await p.request('runtime/capabilities', {}); } }), observe: e => observe.push(e),
    health: async () => ({}), installation: async () => ({}), models: async () => ({ models: [] }), validateSelection: async () => {} };
  let bridge = api.createZCodeBridge(services, m => output.push(m)), ordinal = 0;
  const wait = async predicate => { for (let i = 0; i < 600; i++) { const value = predicate(); if (value) return value; await delay(10); } throw Error('M2 fixture timeout'); };
  const rpc = async (method, params) => { const id = ++ordinal; bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params })); return wait(() => output.find(m => m.id === id)); };
  const begin = async (providerThreadId, text) => rpc('turn/start', { threadId: 'own', providerThreadId, options, clientRequestId: 'creq_2222222222', input: [{ type: 'text', text, mentions: [] }] });
  try { await fn({ cwd, output, observe, rpc, begin, wait, response: m => bridge.handleLine(JSON.stringify(m)),
    restart: async () => { await bridge.close(); bridge = api.createZCodeBridge(services, m => output.push(m)); } }); }
  finally { await bridge.close(); rmSync(cwd, { recursive: true }); }
}
test('M2 cold baseline suppresses retained running/history rows and permits only new admitted turn', () => {
  const old = rows('old'); old[0].state = 'running'; old[1].state = 'streaming';
  const s = snapshot(old), t = new api.EventTranslator('session1', s.logEpoch, 1, () => {});
  t.baseline(s); assert.deepEqual(t.project(s, 1), []);
  const next = rows('new', 8), c = new api.CommandCorrelation();
  c.begin('command-new', 'creq_2222222222', 1, 100);
  c.authoritative('command-new', 1, 'inputAccepted', 'new');
  const ds = t.project(snapshot([...old, ...next]), 1, c);
  assert.equal(ds.filter(d => d.kind === 'turn.open').length, 1);
  assert.equal(ds.filter(d => d.kind === 'turn.boundary').length, 1);
  assert.ok(ds.every(d => !('providerTurnId' in d) || d.providerTurnId === 'new'));
  assert.deepEqual(t.project(snapshot([...old, ...next]), 1, c), []);
});
test('M2 actual bridge fresh cold attach has no historical item replay/create fallback', async () => harness(async h => {
  const start = await h.rpc('thread/start', { threadId: 'own', cwd: h.cwd, options, instructionMode: 'append' });
  const id = start.result.providerThreadId;
  await h.begin(id, '/wait-for-interrupt'); await h.restart();
  const before = h.output.length;
  const resumed = await h.rpc('thread/resume', { threadId: 'own', providerThreadId: id, cwd: h.cwd, options, instructionMode: 'append' });
  assert.equal(resumed.result.providerThreadId, id);
  assert.equal(h.output.slice(before).flatMap(m => m.params?.deltas ?? []).filter(d => ['turn.open', 'turn.boundary', 'item.open'].includes(d.kind)).length, 0);
  assert.equal(Object.keys(JSON.parse(readFileSync(h.cwd + '/sessions.json', 'utf8'))).length, 1);
  await h.begin(id, 'next');
}));
test('M2 actual bridge question waits, dispatches response once and ignores duplicate', async () => harness(async h => {
  const start = await h.rpc('thread/start', { threadId: 'own', cwd: h.cwd, options, instructionMode: 'append' });
  await h.begin(start.result.providerThreadId, '/question');
  const q = await h.wait(() => h.output.find(m => m.method === 'interaction/request'));
  const result = { kind: 'user_answer', answers: { [q.params.payload.questions[0].id]: { selected: ['once'] } } };
  const projected = h.output.flatMap(m => m.params?.deltas ?? []).find(d => d.kind === 'turn.open');
  assert.equal(q.params.turnId, projected.providerTurnId);
  assert.notEqual(q.params.turnId, 'legacy-' + projected.providerTurnId);
  h.response({ jsonrpc: '2.0', id: q.id, result }); h.response({ jsonrpc: '2.0', id: q.id, result });
  await h.wait(() => h.observe.some(e => e.event === 'native-state' && e.control.phase === 'completedSuccess'));
  assert.equal(h.observe.filter(e => e.event === 'question-response-dispatched').length, 1);
  const session = Object.values(JSON.parse(readFileSync(h.cwd + '/sessions.json', 'utf8')))[0];
  assert.equal(session.questionDispatches, 1);
  assert.match(session.rows.window.find(r => r.kind === 'assistantText').text, /Which effect.*once/);
}));
test('M2 stop cancels pending question before result; late response has no native dispatch', async () => harness(async h => {
  const start = await h.rpc('thread/start', { threadId: 'own', cwd: h.cwd, options, instructionMode: 'append' });
  const id = start.result.providerThreadId; await h.begin(id, '/question');
  const q = await h.wait(() => h.output.find(m => m.method === 'interaction/request'));
  const stop = await h.rpc('thread/stop', { threadId: 'own', providerThreadId: id, intent: 'interrupt', activeTurnId: null });
  assert.ok(stop.result); assert.equal(h.observe.filter(e => e.event === 'question-cancelled').length, 1);
  assert.equal(h.observe.filter(e => e.event === 'question-stop-request').length, 1);
  assert.equal(h.observe.filter(e => e.event === 'question-stop-result-dispatch').length, 1);
  assert.equal(h.output.slice(0, h.output.indexOf(stop)).flatMap(m => m.params?.deltas ?? []).filter(d => d.kind === 'turn.boundary').length, 1);
  h.response({ jsonrpc: '2.0', id: q.id, result: { kind: 'user_answer', answers: {} } });
  assert.equal(h.observe.filter(e => e.event === 'question-response-dispatched').length, 0);
}));
test('M2 unsupported permission in full produces visible error and no auto allow', async () => harness(async h => {
  const start = await h.rpc('thread/start', { threadId: 'own', cwd: h.cwd, options, instructionMode: 'append' });
  await h.begin(start.result.providerThreadId, '/permission');
  await h.wait(() => h.output.find(m => m.method === 'error' && /Unsupported native interaction/.test(m.params?.message)));
  assert.deepEqual(h.observe.filter(e => e.event === 'unsupported-native-interaction').map(e => e.autoAllow), [false]);
  assert.equal(h.output.some(m => m.method === 'interaction/request'), false);
}));
test('M2 extra choices remain visible via free text, unknown answers cannot select silently', () => {
  const q = api.nativeQuestion({ requestId: 'r', sessionId: 's', turnId: 't', toolCallId: 'tool1', toolName: 'AskUserQuestion', questions: [{ question: 'Q?', header: 'Q', options: Array.from({ length: 5 }, (_, i) => ({ value: String(i), label: 'L' + i })) }] });
  assert.equal(q.payload.questions[0].options, undefined); assert.match(q.payload.questions[0].prompt, /L4: 4/);
  assert.throws(() => api.nativeAnswer(q, { kind: 'user_answer', answers: { wrong: { selected: [] } } }), /invalid-question-answer/);
});
test('M2 question anchor refuses absent window, conflicting tool and duplicate identity', () => {
  const q = api.nativeQuestion({requestId:'r',sessionId:'s',turnId:'legacy',toolCallId:'tool1',toolName:'AskUserQuestion',questions:[{question:'Q?',header:'Q',options:[{value:'yes',label:'Yes'}]}]});
  const s = snapshot([{kind:'toolCall',rowId:7,turnId:'message',toolCallId:'tool1',toolName:'AskUserQuestion',status:'pendingApproval'}]);
  s.pendingInteractions = [{interactionId:'r',kind:'userInput',anchorRowId:7,payload:{kind:'userInput',toolCallId:'tool1'}}];
  assert.equal(api.questionTurn(s,q),'message');
  for (const change of [c=>c.rows.window=[],c=>c.pendingInteractions[0].anchorRowId=8,c=>c.pendingInteractions[0].payload.toolCallId='other',c=>c.rows.window.push(c.rows.window[0])]) {
    const c=structuredClone(s);change(c);assert.throws(()=>api.questionTurn(c,q),/unconfirmed-question-anchor/);
  }
  s.pendingInteractions=[];assert.equal(api.questionTurn(s,q),null);
});
test('M2 reverse RPC delivery error is visible failure, never a user answer/cancel dispatch', async () => harness(async h => {
  const start=await h.rpc('thread/start',{threadId:'own',cwd:h.cwd,options,instructionMode:'append'});
  await h.begin(start.result.providerThreadId,'/question');
  const q=await h.wait(()=>h.output.find(m=>m.method==='interaction/request'));
  h.response({jsonrpc:'2.0',id:q.id,error:{code:-32000,message:'fixture delivery failed'}});
  await h.wait(()=>h.observe.some(e=>e.event==='question-cancelled'));
  assert.ok(h.output.some(m=>m.method==='error'&&/Question delivery/.test(m.params.message)));
  assert.equal(h.observe.filter(e=>e.event==='question-response-dispatched').length,0);
}));
