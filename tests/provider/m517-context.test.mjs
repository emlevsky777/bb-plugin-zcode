import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import vm from 'node:vm';
import {nativeReference} from './native-reference.mjs';
import {threadDeltaSchema} from '@get-bb/plugin-sdk/provider-bridge';
import {experimental_createDeltaAssembler} from '@get-bb/plugin-sdk/provider-bridge/testing';
import {api,host,snapshot,frame,delta} from './helpers.mjs';

const usage=(used=4500,max=200000)=>({contextWindow:{usedTokens:used,maxTokens:max,autoCompactThresholdTokens:160000},
  cumulative:{inputTokens:9000000,outputTokens:200000,cacheReadTokens:8000000,cacheWriteTokens:10000}});
const compact=(status='success',after=undefined,origin='auto')=>({rowId:8,kind:'timelineMarker',
  marker:{type:'compact',origin,status,...after===undefined?{}:{tokensAfter:after}}});
function fixture(initial=usage()) {
  const state=new api.ConversationState(()=>{}),sent=[];
  const projector=new api.ContextUsageProjection(d=>sent.push(threadDeltaSchema.parse(d)));
  state.attach(1,'session1','subscription1');let cursor=1;
  const ingest=(f,g=1)=>{const result=state.ingest(f,g);if(result==='applied')projector.project(state.snapshot,f.payload);return result;};
  ingest(frame({...snapshot(),usage:initial}));
  return {state,sent,projector,ingest,last:()=>sent.at(-1),patch:(patch,rows=[])=>{const f=delta([
    ...rows.map(row=>({op:state.snapshot.rows.window.some(r=>r.rowId===row.rowId)?'row.upserted':'row.appended',row})),
    {op:'state.updated',patch}],cursor,cursor+1);cursor++;return ingest(f);},
    publish:(patch,rows=[])=>{const f=frame({...state.snapshot,...patch,...rows.length?{rows:{window:rows,totalCount:rows.length,firstRowId:rows[0].rowId}}:{}},cursor,cursor+1);cursor++;return ingest(f);}};
}

test('M517 real SDK assembler projects current context before a turn and clears unknown values',()=>{
  const f=fixture();assert.equal(f.last().used,4500);assert.equal(f.last().size,200000);assert.equal(f.last().estimated,true);
  const assembler=experimental_createDeltaAssembler({providerId:'own-zcode',textDeltaFlushMs:0});
  const assemble=ds=>assembler.assemble({threadId:'thr_context',providerThreadId:'native_context',deltas:ds});
  const event=assemble(f.sent).find(e=>e.type==='thread/contextWindowUsage/updated');
  assert.deepEqual(event.contextWindowUsage,{usedTokens:4500,modelContextWindow:200000,estimated:true});
  f.patch({usage:{contextWindow:null}});
  const cleared=assemble([f.last()]).find(e=>e.type==='thread/contextWindowUsage/updated');
  assert.deepEqual(cleared.contextWindowUsage,{usedTokens:null,modelContextWindow:null,estimated:true});
  for(const [raw,expected] of [[usage(0),[0,200000]],[usage(50,1000000),[50,1000000]],
    [usage(50,0),[50,null]],[usage(-2),[null,200000]],[usage(NaN,Infinity),[null,null]],
    [null,[null,null]],[42,[null,null]],[{contextWindow:'bad'},[null,null]]]){
    f.patch({usage:raw});assert.deepEqual([f.last().used,f.last().size],expected);
  }
  f.patch({usage:usage(210000,200000)});assert.equal(f.last().used,210000); // Never clamp native accounting.
});

test('M517 repeated/stale frames, whole-key replacement and recovery snapshots do not accumulate context',()=>{
  const f=fixture();const update=delta([{op:'state.updated',patch:{usage:usage(6000,1000000)}}]);
  f.ingest(update);assert.equal(f.last().used,6000);assert.equal(f.last().size,1000000);
  const n=f.sent.length;assert.equal(f.ingest(update),'duplicate');assert.equal(f.ingest(update,0),'stale');assert.equal(f.sent.length,n);
  f.ingest(frame({...f.state.snapshot,usage:usage(6000,1000000)},2,3));assert.equal(f.sent.length,n);
  f.ingest(delta([{op:'state.updated',patch:{usage:{cumulative:usage().cumulative}}}],3,4));
  assert.equal(f.last().used,null);assert.equal(f.last().size,null);
});

test('M517 every successful compact clears use until main accounting, including cold seeds and ordered frames',()=>{
  for(const origin of ['auto','manual']) {
    const f=fixture();f.publish({},[compact('running',undefined,origin)]);
    f.publish({usage:usage(800)},[compact('success',800,origin)]);assert.equal(f.last().used,null);
    const g=fixture();g.publish({},[compact('running',undefined,origin)]);
    g.publish({},[compact('success',undefined,origin)]);assert.equal(g.last().used,null);
    g.publish({control:{phase:'idle'}});assert.equal(g.last().used,null);
    g.patch({usage:usage(700),config:{model:'other'}});assert.equal(g.last().used,null);
    // A different count alone does not prove main-request accounting.
    g.publish({usage:usage(900)});assert.equal(g.last().used,null);
    const main=usage(700);main.cumulative.inputTokens+=600;
    g.patch({usage:main});assert.equal(g.last().used,700);
    const k=fixture();k.publish({usage:usage(800)},[compact('success',800,origin)]);
    const sameCount=usage(800);sameCount.cumulative.outputTokens++;
    k.patch({usage:sameCount});assert.equal(k.last().used,800);

    const batched=fixture(),finalMain=usage(2200);finalMain.cumulative.inputTokens+=2000;
    batched.ingest(delta([{op:'row.appended',row:compact('success',800,origin)},
      {op:'state.updated',patch:{usage:usage(800)}},{op:'state.updated',patch:{usage:finalMain}}]));
    assert.equal(batched.last().used,2200);
    const inverse=fixture();inverse.ingest(delta([{op:'state.updated',patch:{usage:finalMain}},
      {op:'row.appended',row:compact('success',800,origin)},
      {op:'state.updated',patch:{usage:{...usage(800),cumulative:finalMain.cumulative}}}]));
    assert.equal(inverse.last().used,null);
  }
  for(const status of ['failed','noop','cancelled']) {
    const f=fixture();f.publish({},[compact('running')]);f.publish({},[compact(status)]);assert.equal(f.last().used,4500);
  }
  const cold=new api.ContextUsageProjection(()=>{}),published=[];
  const restored=new api.ContextUsageProjection(d=>published.push(d));restored.reset();
  restored.project({...snapshot([compact('success',900)]),usage:usage(900)},frame().payload);
  assert.deepEqual(published.map(d=>d.used),[null,null]); // Capacity is restored, but messages-only use stays unknown.
  const measured=usage(1200);measured.cumulative.inputTokens+=1000;
  restored.project({...snapshot([compact('success',900)]),usage:measured},frame().payload);
  assert.equal(published.at(-1).used,1200);
  const afterMain=[];new api.ContextUsageProjection(d=>afterMain.push(d)).project({...snapshot([compact('success',900)]),usage:measured});
  assert.equal(afterMain.at(-1).used,1200); // Historical compact does not suppress a different native main seed.
  cold.project({...snapshot(),usage:null}); // Invalid optional metric does not throw.
});

// Execute actual installed native methods in a VM with only their non-accounting
// row/control helpers stubbed. No native entrypoint, owner files or model dispatch.
function nativeMethods() {
  const {source,fn}=nativeReference();
  const take=(a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i+a.length);assert.ok(i>=0&&j>i);return source.slice(i,j);};
  const context=vm.createContext({});
  vm.runInContext(['Ndt','Zgn','Xgn','qK','Mji','OJn','tEe','zMi','$Mi','MMi','NMi'].map(fn).join(';'),context);
  const methods=[take('onModelComplete(t)','onCompactLifecycle(t)'),take('onCompactLifecycle(t)','onTargetChanged(t)'),
    take('seedUsage(t)','seedWorkflowActivityHistory(t)'),take('onModelSelected(t)','onModelComplete(t)')].join(',');
  vm.runInContext(`const eEe='cold';
    globalThis.methods={${methods}};`,context);
  return {methods:context.methods,seed:context.Mji,capacity:context.OJn};
}
function nativeProjection(n) {
  const s={snapshot:{...snapshot(),usage:usage(),config:{provider:'fixture',model:'old',thought:'',thoughtLevels:[]},control:{activeWorks:[]}},
    contextWindowState:{usedTokens:4500,maxTokens:200000,touchedByEvent:false},turnHeaderRowIdByTurnId:new Map(),
    compactMarkerRowIdByOperationId:new Map(),entityIdByRowId:new Map(),editTargetByEntityId:new Map(),
    acceptsActiveModelEvent:()=>false,turnIdOf:()=> 'main',findRow:()=>null,rowIdForMessageId:()=>null,
    rowBase:()=>({rowId:8}),controlPatch:patch=>({...s.snapshot.control,...patch}),ms:()=>0};
  Object.assign(s,n.methods);return s;
}

test('M517 pinned native main/auxiliary usage and automatic/manual compaction feed our existing V4 state path',()=>{
  const n=nativeMethods(),s=nativeProjection(n),f=fixture();
  const apply=ops=>{for(const op of ops)if(op.op==='state.updated')Object.assign(s.snapshot,op.patch);
    f.patch({usage:s.snapshot.usage},ops.filter(d=>d.op==='row.appended'||d.op==='row.upserted').map(d=>d.row));};
  apply(s.onModelComplete({payload:{querySource:'main_turn',usage:{inputTokens:6000,outputTokens:80},contextWindow:1000000}}));
  assert.equal(f.last().used,6080);assert.equal(f.last().size,1000000);
  assert.equal(s.snapshot.usage.cumulative.inputTokens,9006000);
  for(const querySource of ['subagent','tool_internal','context_compaction']) {
    assert.deepEqual(JSON.parse(JSON.stringify(s.onModelComplete({payload:{querySource,usage:{inputTokens:99999,outputTokens:20}}}))),[]);
  }
  for(const trigger of ['auto','manual']) {
    const ops=s.onCompactLifecycle({payload:{operationId:trigger,status:'completed',trigger,postCompactTokenCount:800,truePostCompactTokenCount:700}});
    // Native row helper is stubbed; accounting/precedence and state.updated are real.
    const w=ops.find(d=>d.op==='state.updated'&&d.patch.usage).patch.usage.contextWindow;
    assert.equal(w.usedTokens,700);assert.equal(w.maxTokens,1000000);
    apply(ops);assert.equal(f.last().used,null);
  }
  apply(s.onModelComplete({payload:{querySource:'main_turn',usage:{inputTokens:2000,outputTokens:40},contextWindow:1000000}}));
  assert.equal(f.last().used,2040);
});

test('M517 actual native missing-usage zero is unknown after history, not an empty context',()=>{
  const n=nativeMethods(),s=nativeProjection(n),f=fixture();
  f.publish({},[{rowId:1,kind:'turnHeader',turnId:'main',state:'completedSuccess'}]);
  const ops=s.onModelComplete({payload:{querySource:'main_turn',usage:{},contextWindow:1000000}});
  const patch=ops.find(d=>d.patch?.usage).patch;assert.equal(patch.usage.contextWindow.usedTokens,0);
  f.patch(patch);assert.equal(f.last().used,null);assert.equal(f.last().size,1000000);
  const truncated=fixture();truncated.publish({usage:usage(0),rows:{window:[],totalCount:900,firstRowId:null}});
  assert.equal(truncated.last().used,null);
});

test('M517 native cold seed and selected/restored model capacity do not inherit the runtime 200K default',()=>{
  const n=nativeMethods(),selection={modelId:'wide'};
  const session={app:{runtime:{getSessionModelSelection:()=>null},getModelOption:x=>({contextWindow:x.modelId==='wide'?1000000:200000})},restoredModelSelection:selection};
  const capacity=n.capacity({},session);assert.equal(capacity,1000000);
  const s=nativeProjection(n);s.snapshot.usage={...usage(),contextWindow:null};s.contextWindowState={usedTokens:0,maxTokens:null,touchedByEvent:false};
  s.seedUsage(n.seed({used:1400},capacity));assert.equal(s.snapshot.usage.contextWindow.maxTokens,1000000);
  const f=fixture(s.snapshot.usage);assert.equal(f.last().used,1400);assert.equal(f.last().size,1000000);
  const change=s.onModelSelected({traceId:'live',payload:{contextWindow:256000,modelSelection:{providerId:'fixture',modelId:'narrow'}}});
  const patch=change.find(d=>d.patch.usage).patch;f.patch(patch);assert.equal(f.last().size,256000);assert.equal(f.last().used,1400);
  Object.assign(s.snapshot,patch);
  const unknown=s.onModelSelected({traceId:'live',payload:{contextWindow:null,modelSelection:{providerId:'fixture',modelId:'unknown'}}});
  f.patch(unknown.find(d=>d.patch.usage).patch);assert.equal(f.last().size,null);assert.equal(f.last().used,null);
  assert.equal(n.seed({used:0},capacity),null);
});

test('M517 bridge publishes and clears cold native context through the actual attachment and ordinary turn path',async()=>{
  const root=mkdtempSync('/tmp/m517-'),file=join(root,'sessions.json'),out=[];
  const id='sess_context',native={...snapshot(),usage:usage(1700,1000000),control:{phase:'completedSuccess',activeWorks:[]},backgroundWorks:[],pendingInteractions:[]};
  writeFileSync(file,JSON.stringify({[id]:native}));
  const bridge=host.createZCodeBridge({prepare:async()=>({launch:{executable:process.execPath,args:[resolve('tests/provider/fake-v4.mjs'),'v4',file],cwd:root,
    env:api.childEnvironment(process.env,{ELECTRON_RUN_AS_NODE:process.env.ELECTRON_RUN_AS_NODE})},auth:new api.ReadOnlyAuth(join(root,'missing')),configure:async()=>{}}),
    health:async()=>({}),installation:async()=>({}),models:async()=>({}),validateSelection:async()=>{}},m=>out.push(m));
  let ordinal=0;
  const rpc=async(method,params)=>{const id=++ordinal;bridge.handleLine(JSON.stringify({jsonrpc:'2.0',id,method,params}));
    for(let i=0;i<500;i++){const r=out.find(m=>m.id===id);if(r)return r;await delay(10);}throw Error('RPC timeout');};
  const options={permissionMode:'full',permissionScope:'full',approvalReviewer:null,permissionEscalation:null,model:'GLM-5.3',reasoningLevel:'max',envVars:{}};
  try {
    assert.ok((await rpc('thread/resume',{threadId:'thr_2222222222',providerThreadId:id,cwd:root,options,instructionMode:'append',dynamicTools:[],disallowedTools:[]})).result);
    const deltas=()=>out.flatMap(m=>m.method==='thread/delta'?m.params.deltas:[]);
    assert.deepEqual(deltas().filter(d=>d.kind==='contextWindow').map(d=>[d.used,d.size]),[[null,null],[1700,1000000]]);
    assert.ok((await rpc('turn/start',{threadId:'thr_2222222222',providerThreadId:id,options,clientRequestId:'creq_3333333333',input:[{type:'text',text:'ordinary'}]})).result);
    for(let i=0;i<100&&!deltas().some(d=>d.kind==='turn.boundary');i++)await delay(10);
    assert.ok(deltas().some(d=>d.kind==='turn.boundary'));
    assert.equal(deltas().filter(d=>d.kind==='contextWindow').length,2);
  }finally{await bridge.close();rmSync(root,{recursive:true,force:true});}
});
