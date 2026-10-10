import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { api, host } from './helpers.mjs';
import { threadDeltaSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { experimental_createDeltaAssembler } from '@get-bb/plugin-sdk/provider-bridge/testing';
// Native vocabulary from M4.6.4 own guided/attachment primaries; fake timing
// deliberately exercises late/duplicate frames, not a claim of live timing.
const options = { permissionMode:'full', permissionScope:'full', approvalReviewer:null, permissionEscalation:null,
  model:'GLM-5.3', reasoningLevel:'max', envVars:{} };
const text = value => [{type:'text',text:value}];
async function fixture(run) {
  const root = mkdtempSync('/tmp/m464-steer-'), file = join(root,'sessions.json'), output = [];
  let child, completeBeforeSend=false;
  const bridge = host.createZCodeBridge({ prepare:async()=>({launch:{executable:process.execPath,args:[resolve('tests/provider/fake-v4.mjs'),'v4',file],cwd:root,
    env:api.childEnvironment(process.env,{ELECTRON_RUN_AS_NODE:process.env.ELECTRON_RUN_AS_NODE})},auth:new api.ReadOnlyAuth(join(root,'missing')),configure:async p=>{child=p;},
    beforeInput:async()=>{if(completeBeforeSend){completeBeforeSend=false;await child.request('fixture/complete',{});}}}),
    health:async()=>({}),installation:async()=>({}),models:async()=>({models:[]}),validateSelection:async()=>{} },m=>output.push(m));
  let ordinal=0;
  async function rpc(method,params) {
    const id=++ordinal; bridge.handleLine(JSON.stringify({jsonrpc:'2.0',id,method,params}));
    for(let i=0;i<400;i++){const r=output.find(m=>m.id===id);if(r)return r;await delay(10);}throw Error('RPC timeout');
  }
  try {
    const start=await rpc('thread/start',{threadId:'thr_2222222222',cwd:root,options,instructionMode:'append',dynamicTools:[],disallowedTools:[]});
    assert.ok(start.result,JSON.stringify(start));
    const session=()=>Object.values(JSON.parse(readFileSync(file,'utf8')))[0];
    const params={threadId:'thr_2222222222',providerThreadId:start.result.providerThreadId,options};
    const deltas=()=>output.flatMap(m=>m.method==='thread/delta'?m.params.deltas:[]);
    await rpc('turn/start',{...params,clientRequestId:'creq_2222222222',input:text('/wait-for-interrupt')});
    for(let i=0;i<100&&!deltas().some(d=>d.kind==='turn.open');i++)await delay(10);
    const expectedTurnId=session().rows.window.find(r=>r.kind==='turnHeader').turnId;
    await run({rpc,params,expectedTurnId,session,deltas,root,armBoundary:()=>{completeBeforeSend=true;}});
  } finally {await bridge.close();rmSync(root,{recursive:true,force:true});}
}
test('M464 inject validates turn before native send; ordinary start survives refusal',()=>fixture(async f=>{
  assert.equal(api.bridgeCapabilities.steerMode,'inject');
  const p={...f.params,expectedTurnId:f.expectedTurnId,clientRequestId:'creq_3333333333',input:text('guide')};
  for(const change of [{expectedTurnId:'wrong'},{providerThreadId:'wrong'}])
    assert.ok((await f.rpc('turn/steer',{...p,...change})).error);
  assert.equal(f.session().steerCommands,undefined);
  assert.ok((await f.rpc('turn/steer',{...p,input:text('/steer-reject')})).error);
  assert.equal(f.deltas().filter(d=>d.clientRequestId===p.clientRequestId).length,0);
  assert.ok((await f.rpc('turn/steer',{...p,clientRequestId:'creq_5555555555',input:text('/steer-wrong-ack')})).error);
  assert.equal(f.deltas().filter(d=>d.clientRequestId==='creq_5555555555').length,0);
  assert.ok((await f.rpc('turn/start',{...f.params,clientRequestId:'creq_4444444444',input:text('ordinary')})).result);
}));
test('M47 A46 changed steer options keep current model/reasoning/auth/config without rejection',()=>fixture(async f=>{
  const p={...f.params,expectedTurnId:f.expectedTurnId,clientRequestId:'creq_3333333333',input:text('guide'),
    options:{...options,model:'GLM-5.3-Flash',reasoningLevel:'high',instructions:'NEW_INSTRUCTIONS',envVars:{HOME:'/changed'},
      providerOptions:{authMode:'backup',useZCodePlugins:true}}};
  assert.ok((await f.rpc('turn/steer',p)).result);
  const sent=f.session().steerCommands[0].payload;
  assert.equal(sent.modelSelection.modelId,'GLM-5.3');assert.equal(sent.modelSelection.options.reasoningLevel,'max');
  assert.equal(sent.requestedDelivery,'guide');assert.equal(f.deltas().filter(d=>d.kind==='input.accepted'&&d.clientRequestId===p.clientRequestId).length,1);
}));
for(const kind of ['guided','queue','boundary']) test('M464 ACK acceptance once with native '+kind+' and duplicate late frames',()=>fixture(async f=>{
  const p={...f.params,expectedTurnId:f.expectedTurnId,clientRequestId:'creq_3333333333',input:text(kind==='guided'?'guide':kind==='queue'?'/steer-queue':'/steer-boundary')};
  if(kind==='queue'){
    const path=join(f.root,'attached.txt');writeFileSync(path,'OWN_ATTACHMENT');
    p.input.push({type:'localFile',path,name:'attached.txt',mimeType:'text/plain',sizeBytes:14});
  }
  if(kind==='boundary')f.armBoundary();
  assert.ok((await f.rpc('turn/steer',p)).result);
  await delay(180);
  const accepted=f.deltas().filter(d=>d.kind==='input.accepted'&&d.clientRequestId===p.clientRequestId);
  assert.equal(accepted.length,1);assert.equal(accepted[0].providerTurnId,f.expectedTurnId);threadDeltaSchema.parse(accepted[0]);
  assert.ok((await f.rpc('turn/steer',p)).error);
  assert.equal(f.session().steerCommands.length,1);
  assert.equal(f.session().steerCommands[0].payload.requestedDelivery,'guide');
  const headers=f.session().rows.window.filter(r=>r.kind==='turnHeader');
  assert.equal(headers.length,kind==='guided'?1:2);
  const terminals=f.deltas().filter(d=>d.kind==='turn.boundary');
  assert.equal(terminals.length,headers.length,JSON.stringify(f.deltas()));
  assert.ok(terminals.every(d=>d.status==='completed'));
  assert.equal(new Set(terminals.map(d=>d.providerTurnId)).size,terminals.length);
  const assembler=experimental_createDeltaAssembler({providerId:'zcode',textDeltaFlushMs:0});
  const events=assembler.assemble({threadId:'thr_2222222222',providerThreadId:f.params.providerThreadId,deltas:f.deltas()});
  assert.equal(events.filter(e=>e.type==='turn/input/accepted'&&e.clientRequestId===p.clientRequestId).length,1);
  assert.equal(events.filter(e=>e.type==='turn/completed').length,headers.length);
  if(kind==='queue')assert.equal(f.session().steerCommands[0].payload.attachments.length,1);
}));
test('M464 Stop during accepted steer settles original terminal once without resend',()=>fixture(async f=>{
  const p={...f.params,expectedTurnId:f.expectedTurnId,clientRequestId:'creq_3333333333',input:text('guide')};
  assert.ok((await f.rpc('turn/steer',p)).result);
  assert.ok((await f.rpc('thread/stop',{...f.params,intent:'interrupt',activeTurnId:f.expectedTurnId})).result);
  assert.equal(f.deltas().filter(d=>d.kind==='input.accepted'&&d.clientRequestId===p.clientRequestId).length,1);
  assert.equal(f.deltas().filter(d=>d.kind==='turn.boundary'&&d.providerTurnId===f.expectedTurnId).length,1);
}));
