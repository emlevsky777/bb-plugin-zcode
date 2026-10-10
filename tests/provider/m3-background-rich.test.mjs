import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api, snapshot, inputs } from './helpers.mjs';
import { threadDeltaSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { experimental_assembleCapturedThreadEvents as assemble } from '@get-bb/plugin-sdk/provider-bridge/testing';
// Native OSS29628c9 snapshot363/rows191/toolDisplay155, projection4226.
// Installed adapter1384/1499: background progress/close use thread scope.
const work = status => ({ workId: 'exec-own', kind: 'bash', title: 'own bounded command', status, anchorRowId: 2, startedAt: 10 });
const rs = state => [
  { rowId: 1, kind: 'turnHeader', turnId: 'turn1', sourceCommandId: 'command-turn1', state },
  { rowId: 2, kind: 'toolCall', turnId: 'turn1', toolCallId: 'tool1', toolName: 'Bash', status: 'success',
    input: { command: 'sleep 5', run_in_background: true }, backgrounded: true, workId: 'exec-own', output: { text: 'background task started' } },
];
const snap = (state, status) => ({ ...snapshot(rs(state)), control: { phase: state === 'running' ? 'running' : 'completedSuccess',
  activeWorks: state === 'running' ? [{ kind: 'primaryTurn' }] : [] }, backgroundWorks: [work(status)], pendingInteractions: [] });
const events = messages => assemble(messages, 'zcode');
test('Bash foreground boundary once, thread-scoped progress/completion after it, next turn independent', () => {
  const out = [], warn = [], l = new api.SessionLifecycle('thr_2222222222', 'session1', 'epoch1', 1,
    d => warn.push(d.code), m => out.push(m), async () => 0, '/own');
  l.baseline({ ...snapshot(), backgroundWorks: [] });
  l.project(snap('running', 'running'), 1, 'session1', inputs(rs('running')));
  l.project(snap('completedSuccess', 'running'), 1, 'session1');
  l.project(snap('completedSuccess', 'resultPending'), 1, 'session1');
  l.project(snap('completedSuccess', 'resultPending'), 1, 'session1');
  const ev = events(out), boundary = ev.findIndex(e => e.type === 'turn/completed'), complete = ev.findIndex(e => e.type === 'item/backgroundTask/completed');
  assert.equal(ev.filter(e => e.type === 'turn/completed').length, 1);
  assert.ok(complete > boundary);
  const task = ev[complete]; assert.equal(task.item.taskStatus, 'completed'); assert.equal(task.scope.kind, 'thread');
  assert.equal(ev.filter(e => e.type === 'item/backgroundTask/completed').length, 1);
  const next = [{ rowId: 3, kind: 'turnHeader', turnId: 'next', state: 'completedSuccess', sourceCommandId: 'command-next' }];
  l.project({ ...snapshot([...rs('completedSuccess'), ...next]), control: { phase: 'completedSuccess', activeWorks: [] },
    backgroundWorks: [work('resultPending')], pendingInteractions: [] }, 1, 'session1', inputs(next));
  assert.equal(events(out).filter(e => e.type === 'turn/completed').length, 2);
});
test('unknown work status/kind block boundary; vanished running task fails, never fabricated success', () => {
  for (const background of [{ ...work('running'), kind: 'future' }, work('future'), { ...work('running'), kind: 'workflow' }]) {
    const s = snap('completedSuccess', 'running'); s.backgroundWorks = [background];
    assert.equal(new api.EventTranslator('session1','epoch1',1,()=>{}).project(s,1,inputs(s.rows.window)).some(d=>d.kind==='turn.boundary'),false);
  }
  const warnings = [], t = new api.BackgroundTasks('session1', d => warnings.push(d.code));
  t.baseline({ ...snapshot(), backgroundWorks: [] }); t.project(snap('running','running'));
  const ds = t.project({ ...snapshot(), backgroundWorks: [] });
  assert.equal(ds[0].item.taskStatus, 'failed'); assert.ok(warnings.includes('background-outcome-unconfirmed'));
});
test('actual installed background payload without optional row workId binds only exact native output identity', () => {
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/m3-native-background.json',import.meta.url),'utf8'));
  for(const corrupt of [false,true]){
    const row=structuredClone(fixture.row);if(corrupt)row.output.text=row.output.text.replace(fixture.work.workId,'exec-unrelated');
    const s={...snapshot([row]),backgroundWorks:[fixture.work]},t=new api.BackgroundTasks('session1',()=>{});
    t.baseline({...snapshot(),backgroundWorks:[]});const ds=t.project(s);
    assert.equal(ds.filter(v=>v.kind==='item.open').length,corrupt?0:1);
  }
});
test('Stop/release after boundary close task before reply and await real cleanup; cold ledger closes only unfinished IDs', async () => {
  const root = mkdtempSync(join(tmpdir(),'m3-task-')), file = join(root,'tasks.json');
  try {
    for (const intent of ['interrupt','release']) {
      const out = []; let releaseDone = false;
      const l = new api.SessionLifecycle('thr_2222222222','session1','epoch1',1,()=>{},m=>out.push(m),async()=>{
        await delay(10); releaseDone = true; return 0;
      },'/own',file);
      l.baseline({ ...snapshot(), backgroundWorks: [] });
      const s = snap('completedSuccess','running'); s.backgroundWorks = [{ ...work('running'), workId: 'exec-' + intent }];
      s.rows.window[1].workId = 'exec-' + intent;
      l.project(s,1,'session1',inputs(s.rows.window));
      await l.stop(intent,1,'session1'); assert.equal(releaseDone,true);
      const ev = events(out); assert.equal(ev.filter(e=>e.type==='turn/completed').length,1);
      assert.equal(ev.find(e=>e.type==='item/backgroundTask/completed' && e.item.taskStatus !== 'failed')?.item.taskStatus,
        'killed');
    }
    const t = new api.BackgroundTasks('session1',()=>{},file); t.baseline({ ...snapshot(),backgroundWorks:[] });
    t.project(snap('running','running'));
    const recovered = new api.BackgroundTasks('session1',()=>{},file);
    const ds = recovered.baseline(snap('completedSuccess','running')); assert.equal(ds.length,1); assert.equal(ds[0].kind,'provider.warning');
    recovered.recoveryDelivered();
    assert.equal(recovered.project(snap('completedSuccess','running')).length,0);
    assert.equal(new api.BackgroundTasks('session1',()=>{},file).baseline(snap('completedSuccess','running')).length,0);
    assert.doesNotMatch(readFileSync(file,'utf8'),/sleep 5|bounded command|supervisorPid/);
  } finally { rmSync(root,{recursive:true}); }
});
test('documented SDK cold assembler limit: persisted provider key does not retain canonical task ID', () => {
  const key={providerItemId:'["session1","background","exec-own"]'},item={type:'backgroundTask',familyId:key.providerItemId,
    taskType:'bash',description:'own fixture',taskStatus:'running',status:'pending',skipTranscript:false};
  const message=deltas=>[{jsonrpc:'2.0',method:'thread/delta',params:{threadId:'thr_2222222222',deltas}}];
  const before=events(message([{kind:'turn.open',providerTurnId:'t'},
    {kind:'item.open',providerTurnId:'t',key,item},{kind:'turn.boundary',providerTurnId:'t',status:'completed'}]));
  const after=events(message([{kind:'item.close',key,item:{...item,taskStatus:'failed',status:'failed'},status:'failed'}]));
  const opened=before.find(v=>v.item?.type==='backgroundTask'),closed=after.find(v=>v.item?.type==='backgroundTask');
  assert.equal(opened.item.familyId,closed.item.familyId);
  assert.notEqual(opened.item.id,closed.item.id); // This is a known limit, not a passed Resume feature.
});
test('source-backed native rich shapes preserve real output and leave unavailable fields absent', () => {
  for(const name of ['baseline100ms','developerSupervisor','measure']) assert.throws(()=>api.executionOptions({permissionMode:'full',permissionScope:'full',
    approvalReviewer:null,permissionEscalation:null,providerOptions:{[name]:true}}),/providerOptions/);
  const cases = [
    ['Bash',{command:'printf own'}, {text:'own'}, 'command'],
    ['Read',{file_path:'/own/a'}, {text:'own'}, 'fileRead'],
    ['Write',{file_path:'/own/a',content:'own'}, {text:'File created successfully at: /own/a'}, 'fileChange'],
    ['Edit',{file_path:'/own/a',old_string:'own',new_string:'next'}, {text:'updated'}, 'fileChange'],
    ['Grep',{pattern:'own',path:'/own'}, {text:'/own/a:own'}, 'search'],
    ['Glob',{pattern:'*.txt',path:'/own'}, {text:'/own/a.txt'}, 'search'],
    ['WebSearch',{query:'own'}, {text:'native result'}, 'webSearch'],
    ['WebFetch',{url:'https://example.test/',prompt:'own'}, {text:'native result'}, 'webFetch'],
    ['TodoWrite',{todos:[{content:'own',status:'in_progress',priority:'high'}]}, {text:'native plan saved'}, 'planSteps'],
    ['mcp__own',{arg:'own'}, {text:'native MCP result',display:{kind:'mcp_tool',serverName:'own',toolName:'native'}}, 'tool'],
    ['Future',{unknown:true},{text:'native result'},'tool'],
  ];
  const warnings=[];
  for(const [tool,input,output,type] of cases){
    const item=api.richTool({rowId:2,kind:'toolCall',turnId:'t',toolName:tool,status:'success',input,output},'/own',d=>warnings.push(d.code));
    assert.equal(item.type,type); threadDeltaSchema.parse({kind:'item.open',providerTurnId:'t',key:{providerItemId:tool},item});
    assert.equal(item.exitCode,undefined); assert.equal(item.durationMs,undefined);
    if(type==='command') assert.equal(item.aggregatedOutput,'own');
    if(type==='fileChange') assert.equal(item.changes[0].diff,undefined);
  }
  assert.ok(warnings.includes('generic-native-tool'));
  assert.equal(api.richTool({rowId:2,kind:'toolCall',toolName:'Bash',input:{future:'unknown'}},'/own',()=>{}).type,'tool');
});
test('supervisor activity control stays separate from native stdin and Stop settles ownership', async () => {
  const messages=[], death=[];
  const p=new api.NativeProcess({executable:process.execPath,args:['-e','process.stdin.resume();'],cwd:process.cwd(),env:process.env},1,null,m=>messages.push(m),e=>death.push(e),60000,()=>{});
  try { p.activity('idle'); await delay(100); p.activity('active'); await delay(100);
    assert.deepEqual(messages,[]); assert.deepEqual(death,[]); assert.equal(await p.close(),0);
  } finally { await p.close(); }
});
