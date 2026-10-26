import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import { api, plugin, snapshot, inputs } from './helpers.mjs';
import { experimental_createDeltaAssembler } from '@get-bb/plugin-sdk/provider-bridge/testing';
const options={permissionMode:'full',permissionScope:'full',approvalReviewer:null,permissionEscalation:null};
const header={rowId:1,kind:'turnHeader',turnId:'turn1',state:'running'};
const anchor={rowId:2,kind:'toolCall',turnId:'turn1',toolCallId:'agent-call',toolName:'Agent',status:'running',input:{subagent_type:'general-purpose'}};
const child={rowId:3,kind:'subagent',turnId:'turn1',parentToolCallId:'agent-call',childSessionId:'native-child',subagentType:'general-purpose',status:'running',summaryText:''};
test('M48 strict providerOptions, enabled default/signature and real bb derive',async()=>{
  const enabled=api.executionOptions(options),off=api.executionOptions({...options,providerOptions:{providerSubagentsEnabled:false}});
  assert.equal(enabled.providerSubagentsEnabled,true);assert.equal(off.providerSubagentsEnabled,false);assert.notEqual(enabled.signature,off.signature);
  for(const v of [null,0,'false',{},[]])assert.throws(()=>api.executionOptions({...options,providerOptions:{providerSubagentsEnabled:v}}),/Invalid subagent/);
  let registration,definition;
  await plugin({settings:{define:d=>{definition=d;return{get:async()=>({authMode:'desktop'}),onChange:()=>{}};}},providers:{register:r=>{registration=r;return{};}}});
  assert.equal(definition.subagentsDisabled.default,false);
  assert.equal(registration.deriveProviderOptions({settings:{subagentsDisabled:true}}).providerSubagentsEnabled,false);
  assert.equal(registration.deriveProviderOptions({settings:{}}).providerSubagentsEnabled,true);
});
for(const background of [false,true])test('M48 real SDK delegation schema/assembler relation, replay and terminal '+background,()=>{
  const messages=[],warnings=[],l=new api.SessionLifecycle('thr_2222222222','session','epoch1',1,w=>warnings.push(w),m=>messages.push(m),async()=>0);
  const a={...anchor,input:{...anchor.input,run_in_background:background}},c={...child,backgrounded:background?true:undefined,workId:background?'work':undefined};
  const s=snapshot([header,a,c]);s.backgroundWorks=background?[{workId:'work',kind:'local_agent',title:'child',status:'running'}]:[];
  l.project(s,1,'session',inputs(s.rows.window));l.project(s,1,'session');
  if(background){const b=snapshot([{...header,state:'completedSuccess'},{...a,status:'success'},c]);b.backgroundWorks=s.backgroundWorks;l.project(b,1,'session');}
  const done=snapshot([{...header,state:'completedSuccess'},{...a,status:'success'},{...c,status:'success',summaryText:'CHILD_OK'}]);
  done.backgroundWorks=background?[{workId:'work',kind:'local_agent',title:'child',status:'resultPending'}]:[];
  l.project(done,1,'session');l.project(done,1,'session');
  const ds=messages.flatMap(m=>m.params.deltas),as=experimental_createDeltaAssembler({providerId:'zcode',textDeltaFlushMs:0});
  const events=as.assemble({threadId:'thr_2222222222',providerThreadId:'session',deltas:ds});
  const opened=events.filter(e=>e.type==='item/started'&&e.item.type==='delegation'),closed=events.filter(e=>['item/completed','item/delegation/completed'].includes(e.type)&&e.item.type==='delegation');
  assert.equal(opened.length,1);assert.equal(closed.length,1);assert.equal(opened[0].item.childRef,'native-child');
  assert.equal(opened[0].item.parentToolCallId,events.find(e=>e.type==='item/started'&&e.item.type==='toolCall').item.id);
  assert.equal(closed[0].item.status,'completed');assert.equal(closed[0].item.summary,'CHILD_OK');
  if(background)assert.equal(closed[0].scope.kind,'thread');
  else assert.ok(ds.findIndex(d=>d.kind==='item.close'&&d.item?.type==='delegation')<ds.findIndex(d=>d.kind==='turn.boundary'));
  assert.deepEqual(warnings.filter(w=>w.code.startsWith('subagent-')),[]);
});
test('M48 running/resultPending/unknown cannot become success; Stop and baseline honest',()=>{
  const w=[],p=new api.Subagents('session','epoch1',x=>w.push(x)),s=snapshot([header,anchor,{...child,backgrounded:true,workId:'work'}]);
  s.backgroundWorks=[{workId:'work',status:'running'}];
  p.project(s,[{kind:'turn.open',providerTurnId:'turn1'}]);
  for(const status of ['running','resultPending','unknown']){
    s.backgroundWorks[0].status=status;s.rows.window[2].status=status==='resultPending'?'running':'success';
    assert.equal(p.project(s,[]).some(d=>d.kind==='item.close'&&d.status==='completed'),false);
  }
  assert.equal(p.settle('interrupted')[0].status,'interrupted');assert.equal(p.settle('interrupted').length,0);
  const q=new api.Subagents('session','epoch1',x=>w.push(x));s.rows.window[2].status='running';q.baseline(s);
  assert.deepEqual(q.project(s,[{kind:'turn.open',providerTurnId:'turn1'}]),[]);assert.ok(w.some(x=>x.code==='subagent-resume-outcome-unconfirmed'));
});
test('M48 installed background snapshot: completed main separates from running/resultPending child resources',()=>{
  for(const status of ['running','resultPending']){
    const s=snapshot([{...header,state:'completedSuccess'},anchor,{...child,backgrounded:true,workId:'work'}]);
    Object.assign(s,{control:{phase:'completedSuccess',activeWorks:[]},pendingInteractions:[],backgroundWorks:[{workId:'work',kind:'subagent',status}]});
    const e=api.inspectExecution(s,()=>{});assert.equal(e.active,true);assert.equal(e.foregroundActive,false);assert.equal(e.blocked,false);assert.equal(e.outcome,'completed');
    const p=new api.Subagents('session','epoch1',()=>{});assert.equal(p.project(s,[{kind:'turn.open',providerTurnId:'turn1'},{kind:'turn.boundary',providerTurnId:'turn1',status:'completed'}]).some(d=>d.kind==='item.close'),false);
    s.backgroundWorks[0].kind='future';assert.equal(api.inspectExecution(s,()=>{}).known,false);
  }
});
test('M48 malformed identity, missing parent and unknown native enum diagnose without blocking ordinary',()=>{
  for(const bad of [{status:'unknown'},{childSessionId:undefined},{parentToolCallId:'other'}]){
    const w=[],p=new api.Subagents('session','epoch1',x=>w.push(x)),s=snapshot([header,anchor,{...child,...bad}]);
    assert.deepEqual(p.project(s,[{kind:'turn.open',providerTurnId:'turn1'}]),[]);assert.equal(w.length,1);
  }
  const w=[];api.parseRow({...child,status:'unknown'},x=>w.push(x));assert.equal(w[0].code,'unknown-row-enum');
});
test('M48 session OFF/ON keeps real HOME, project and user config unwritten',async()=>{
  const root=mkdtempSync('/tmp/m48-'),personalHome=join(root,'personal'),builtin=join(root,'builtin.json');mkdirSync(personalHome);writeFileSync(builtin,'{}');
  const auth=new api.ReadOnlyAuth(join(root,'missing'));auth.read=()=>({apiKey:'SYNTHETIC'});
  const r=api.createNativeServices(join(root,'provider'),{auth,personalHome,discovery:()=>({installed:true,supported:true,sha256:'synthetic',version:'synthetic'}),
    paths:{executable:process.execPath,script:resolve('tests/provider/fake-v4.mjs'),builtin},configure:async()=>{}});
  try{
    const project=join(root,'zcode.json');writeFileSync(project,JSON.stringify({features:{subagent:true,compact:true}}));const bytes=readFileSync(project);
    const setup=await r.services.prepare(root,api.executionOptions({...options,providerOptions:{providerSubagentsEnabled:false}}),{threadId:'own'});setup.bindSession('native');
    assert.equal(setup.launch.env.HOME,personalHome);
    assert.equal(existsSync(join(personalHome,'.zcode/cli/config.json')),false);
    assert.deepEqual(api.executionOptions({...options,providerOptions:{providerSubagentsEnabled:false}},'append',['Bash','Agent']).toolDenylist,['Bash','Agent']);
    assert.deepEqual(readFileSync(project),bytes);
    const resume=await r.services.prepare(root,api.executionOptions(options),{threadId:'own',providerThreadId:'native'});
    assert.equal(resume.launch.env.HOME,setup.launch.env.HOME);
    assert.deepEqual(api.executionOptions(options).toolDenylist,[]);
    assert.equal(existsSync(join(personalHome,'.zcode/cli/config.json')),false);
  }finally{await r.close();rmSync(root,{recursive:true,force:true});}
});
