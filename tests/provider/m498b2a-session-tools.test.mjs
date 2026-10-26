import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {api,plugin} from './helpers.mjs';
const options={permissionMode:'full',permissionScope:'full',approvalReviewer:null,permissionEscalation:null,model:'GLM-5.3',reasoningLevel:'high'};
test('M498b2a one registration: per-command source/refresh/subagents; secret never in options',async()=>{
  let registration,count=0,disposed=0,changed;
  await plugin({settings:{define:()=>({get:async()=>({authMode:'cli',backupKey:'PRIVATE'}),onChange:cb=>{changed=cb;}})},providers:{register:r=>{count++;registration=r;return{dispose:()=>disposed++};}}});
  assert.equal(registration.experimental_bridgeOptions,undefined);
  assert.deepEqual(registration.deriveProviderOptions({settings:{authMode:'coding-plan-key',catalogueRefresh:2,subagentsDisabled:true,backupKey:'PRIVATE'}}),{authMode:'coding-plan-key',catalogueRefresh:2,providerSubagentsEnabled:false,memoryEnabled:true});
  if(changed)await changed({authMode:'cli',subagentsDisabled:false});
  assert.equal(count,1);assert.equal(disposed,0);
});
test('M498b2a session tools create/cold resume/model change/toggle/steer keep same native history',async()=>{
  const root=mkdtempSync('/tmp/m498b2a-'),file=join(root,'sessions.json'),out=[],calls=[];
  const b=api.createZCodeBridge({prepare:async()=>({launch:{executable:process.execPath,args:[resolve('tests/provider/fake-v4.mjs'),'v4',file],cwd:root,env:api.childEnvironment(process.env,{ELECTRON_RUN_AS_NODE:process.env.ELECTRON_RUN_AS_NODE})},auth:new api.ReadOnlyAuth(join(root,'missing')),configure:async c=>{const request=c.request.bind(c);c.request=(method,params)=>{calls.push({method,params});return request(method,params);};}}),health:async()=>({}),installation:async()=>({}),models:async()=>({}),validateSelection:async()=>{}},m=>out.push(m));
  let ordinal=0;async function rpc(method,params){const id=++ordinal;b.handleLine(JSON.stringify({jsonrpc:'2.0',id,method,params}));for(let n=0;n<1000;n++){let r=out.find(m=>m.id===id);if(r){assert.equal(r.error,undefined,JSON.stringify(r));return r.result;}await delay(5);}throw Error('RPC timeout');}
  const construction={threadId:'tools-own',cwd:root,instructionMode:'append',dynamicTools:[],disallowedTools:['Bash','Bash','UnknownTool','Bash(echo:*)'],options:{...options,providerOptions:{providerSubagentsEnabled:false,memoryEnabled:true}}};
  try{const {providerThreadId}=await rpc('thread/start',construction);const state=()=>JSON.parse(readFileSync(file,'utf8'))[providerThreadId];
    assert.deepEqual(state().toolDenylist,['Bash','UnknownTool','Bash(echo:*)','Agent']);
    assert.ok(calls.findIndex(c=>c.method==='session/create')<calls.findIndex(c=>c.method==='v4/conversation/subscribe'));
    const turn={threadId:construction.threadId,providerThreadId,clientRequestId:'creq_2222222222',input:[{type:'text',text:'/wait-for-interrupt'}],options:construction.options};
    await rpc('turn/start',turn);await delay(50);
    const expectedTurnId=state().rows.window.find(r=>r.kind==='turnHeader').turnId;
    await rpc('turn/steer',{...turn,expectedTurnId,clientRequestId:'creq_3333333333',input:[{type:'text',text:'guide'}],options:{...options,providerOptions:{providerSubagentsEnabled:true,memoryEnabled:true}}});
    assert.deepEqual(state().toolDenylist,['Bash','UnknownTool','Bash(echo:*)','Agent']);await delay(180);
    await rpc('turn/start',{...turn,clientRequestId:'creq_4444444444',input:[{type:'text',text:'ordinary'}],options:{...options,model:'GLM-5.3-Flash',providerOptions:{providerSubagentsEnabled:true,memoryEnabled:true}}});
    assert.deepEqual(state().toolDenylist,['Bash','UnknownTool','Bash(echo:*)']);
    const resume=calls.findIndex(c=>c.method==='session/resume');assert.ok(resume>=0&&resume<calls.findIndex((c,i)=>i>resume&&c.method==='v4/conversation/subscribe'));
    assert.equal(Object.keys(JSON.parse(readFileSync(file,'utf8'))).length,1);assert.ok(state().rows.totalCount>0);
  }finally{await b.close();rmSync(root,{recursive:true,force:true});}
});
