import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api, host, plugin, snapshot } from './helpers.mjs';
import { threadDeltaSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { experimental_createDeltaAssembler } from '@get-bb/plugin-sdk/provider-bridge/testing';
const resource = { kind:'command',source:'command',origin:'builtin',trigger:'/',name:'compact',label:'compact',argumentHint:null };
const input = (suffix='') => [{type:'text',text:'/compact'+suffix,mentions:[{start:0,end:8,resource}]}];
const options = { permissionMode:'full',permissionScope:'full',approvalReviewer:null,permissionEscalation:null,model:'GLM-5.3',reasoningLevel:'max',envVars:{} };
test('M471 bb advertises manual compaction to enable its structured command',async()=>{
  let registration;
  await plugin({settings:{define:()=>({get:async()=>({authMode:'cli',catalogueRefresh:0}),onChange:()=>{}})},providers:{register:value=>{registration=value;return{};}}});
  assert.equal(registration.capabilities.supportsManualCompaction,true);
  assert.ok(registration.extensionKinds.compaction.item['~standard'].validate({outcome:'noop'}).value);
  assert.ok(registration.extensionKinds.compaction.item['~standard'].validate({outcome:'unknown'}).issues);
  assert.ok(registration.extensionKinds.compaction.item['~standard'].validate({outcome:'success',extra:true}).issues);
  assert.ok(registration.extensionKinds.compaction.item['~standard'].validate({outcome:['success']}).issues);
});
test('M471 selected compact identity and exact standalone/instruction; ordinary text unchanged',()=>{
  assert.deepEqual(api.compactSelection(input()),{instructions:''});
  assert.deepEqual(api.compactSelection(input(' focus')),{instructions:'focus'});
  for(const value of [[{type:'text',text:'/compact'}],input('Suffix'),[...input(),{type:'text',text:'extra'}],
    [{...input()[0],mentions:[{start:0,end:8,resource:{...resource,origin:'project'}}]}],
    [{...input()[0],text:'prefix /compact',mentions:[{start:7,end:15,resource}]}],
    [{...input()[0],mentions:[...input()[0].mentions,...input()[0].mentions]}]]) assert.equal(api.compactSelection(value),null);
  assert.throws(()=>api.selectedMentions(input('Suffix')),/not supported/);
});
for(const status of ['success','noop','failed','cancelled']) test('M471 native '+status+' is scoped, once; ACK is not success',()=>{
  const ds=[], p=new api.CompactionProjection(values=>ds.push(...values));
  p.begin('command','creq_2222222222');
  const s=snapshot([{rowId:1,kind:'timelineMarker',sourceCommandId:'command',marker:{type:'compact',origin:'manual',status}}]);
  p.project(s);assert.equal(ds.length,0);p.accept('command');assert.equal(ds.some(d=>d.kind==='context.compacted'),false);
  p.project(s);p.project(s);p.accept('command');p.settle('failed');
  assert.equal(ds.filter(d=>d.kind==='input.accepted').length,1);assert.equal(ds.filter(d=>d.kind==='turn.boundary').length,1);
  assert.equal(ds.filter(d=>d.kind==='context.compacted').length,status==='success'?1:0);
  for(const d of ds) threadDeltaSchema.parse(d);
  const assembler=experimental_createDeltaAssembler({providerId:'zcode',textDeltaFlushMs:0});
  const events=assembler.assemble({threadId:'thr_2222222222',providerThreadId:'native',deltas:ds});
  assert.equal(events.filter(e=>e.type==='turn/completed').length,1);
  assert.equal(events.filter(e=>e.type==='thread/compacted').length,status==='success'?1:0);
  const closed=events.find(e=>e.type==='item/completed');
  assert.equal(closed.item.type,'extension');
  assert.equal(closed.item.presentation.title,status==='success'?'Context compacted':status==='noop'?'Compaction skipped':status==='failed'?'Compaction failed':'Compaction stopped');
  assert.throws(()=>p.begin('second','creq_2222222222'),/Duplicate/);
});
test('M471 unrelated/automatic marker cannot prove success; Stop settles without success',()=>{
  const ds=[],p=new api.CompactionProjection(values=>ds.push(...values));p.begin('own','request');p.accept('own');
  for(const [sourceCommandId,origin] of [['other','manual'],['own','auto']]) p.project(snapshot([{rowId:1,kind:'timelineMarker',sourceCommandId,marker:{type:'compact',origin,status:'success'}}]));
  assert.equal(ds.some(d=>d.kind==='context.compacted'),false);p.settle('interrupted');p.settle('interrupted');
  assert.equal(ds.filter(d=>d.kind==='turn.boundary').length,1);assert.equal(ds.at(-1).status,'interrupted');
});
async function fixture(run) {
  const root=mkdtempSync('/tmp/m471-'),file=join(root,'sessions.json'),out=[];
  const bridge=host.createZCodeBridge({prepare:async()=>({launch:{executable:process.execPath,args:[resolve('tests/provider/fake-v4.mjs'),'v4',file],cwd:root,
    env:api.childEnvironment(process.env,{ELECTRON_RUN_AS_NODE:process.env.ELECTRON_RUN_AS_NODE})},auth:new api.ReadOnlyAuth(join(root,'missing')),configure:async()=>{},warnings:['SETUP_WARNING']}),
    compatibility:()=>({message:'COMPAT_WARNING'}),health:async()=>({}),installation:async()=>({}),models:async()=>({}),validateSelection:async()=>{}},m=>out.push(m));
  bridge.setPluginId('own-installed-provider');
  let ordinal=0;
  const rpc=async(method,params)=>{const id=++ordinal;bridge.handleLine(JSON.stringify({jsonrpc:'2.0',id,method,params}));for(let i=0;i<400;i++){const r=out.find(m=>m.id===id);if(r)return r;await delay(10);}throw Error('RPC timeout');};
  try {
    const start=await rpc('thread/start',{threadId:'thr_2222222222',cwd:root,options,instructionMode:'append',dynamicTools:[{name:'own',description:'own',inputSchema:{}}],disallowedTools:[]});
    assert.ok(start.result,JSON.stringify(start));
    await run({rpc,params:{threadId:'thr_2222222222',providerThreadId:start.result.providerThreadId,options},
      session:()=>Object.values(JSON.parse(readFileSync(file,'utf8')))[0],deltas:()=>out.flatMap(m=>m.method==='thread/delta'?m.params.deltas:[])});
  }finally{await bridge.close();rmSync(root,{recursive:true,force:true});}
}
test('M471 bridge bare native compact, instructions preserved, native lock, A48 warnings regression',()=>fixture(async f=>{
  const p={...f.params,clientRequestId:'creq_3333333333',input:input()};
  assert.ok((await f.rpc('turn/start',p)).result);assert.ok((await f.rpc('turn/start',{...p,clientRequestId:'creq_4444444444'})).error);
  await delay(120);assert.ok((await f.rpc('turn/start',p)).error);
  assert.ok((await f.rpc('turn/start',{...p,clientRequestId:'creq_5555555555',input:input(' focus on own marker')})).result);
  await delay(120);assert.equal(f.session().compactCommands.length,2);assert.equal(f.session().compactCommands[1].instructions,'focus on own marker');
  assert.equal(f.session().rows.window.filter(r=>r.kind==='turnHeader').length,2);
  assert.equal(f.deltas().filter(d=>d.kind==='turn.open').length,2);
  assert.equal(f.deltas().filter(d=>d.kind==='turn.boundary').length,2);
  assert.equal(f.deltas().filter(d=>d.kind==='context.compacted').length,2);
  assert.ok(f.deltas().filter(d=>d.kind==='item.open').every(d=>d.item.kind==='own-installed-provider/compaction'));
  const warnings=f.deltas().filter(d=>d.kind==='provider.warning').map(d=>d.summary);
  assert.deepEqual(warnings,['COMPAT_WARNING','SETUP_WARNING']);
  assert.ok((await f.rpc('turn/start',{...p,clientRequestId:'creq_6666666666',input:[{type:'text',text:'ordinary'}]})).result);
}));
test('M471 active focus refuses before send; bare compact uses native admission; Stop is not success',()=>fixture(async f=>{
  assert.ok((await f.rpc('turn/start',{...f.params,clientRequestId:'creq_3333333333',input:[{type:'text',text:'/wait-for-interrupt'}]})).result);
  // ACK precedes the published snapshot. Wait for the authoritative admission,
  // as the existing steer fixture does; persisted fixture bytes are not a frame.
  for(let i=0;i<100&&!f.deltas().some(d=>d.kind==='input.accepted'&&d.clientRequestId==='creq_3333333333');i++)await delay(10);
  const expectedTurnId=f.session().rows.window.find(r=>r.kind==='turnHeader').turnId;
  const p={...f.params,expectedTurnId,clientRequestId:'creq_4444444444',input:input(' focus')};
  assert.match((await f.rpc('turn/steer',p)).error.message,/idle/);assert.equal(f.session().compactCommands,undefined);
  assert.ok((await f.rpc('turn/steer',{...p,input:input()})).result);
  await f.rpc('thread/stop',{...f.params,intent:'interrupt',activeTurnId:expectedTurnId});
  assert.equal(f.deltas().filter(d=>d.kind==='input.accepted'&&d.clientRequestId===p.clientRequestId).length,1);
  assert.equal(f.deltas().some(d=>d.kind==='context.compacted'),false);
}));
