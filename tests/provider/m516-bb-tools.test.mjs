import {nativeReference} from './native-reference.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {z} from 'zod';
import {createFakePluginHost,makePluginAgentConfigurationContext} from '@get-bb/plugin-sdk/testing';
import verification from './fixtures/m516-verification-plugin.ts';
import {api} from './helpers.mjs';
const tool={name:'inspect_bb_context',description:'Inspect BB context',inputSchema:{type:'object',properties:{nonce:{type:'string'}},required:['nonce']},
  presentation:{label:{pending:'Inspecting BB context',completed:'Inspected BB context'},icon:{glyph:'Info'}}};
const options={permissionMode:'full',permissionScope:'full',approvalReviewer:null,permissionEscalation:null,model:'GLM-5.3-Flash',reasoningLevel:'high'};
async function until(fn){for(let i=0;i<1000;i++){const v=fn();if(v)return v;await delay(5);}throw Error('Timed out');}
const post=async(e,method,params={},id=1)=>{const r=await fetch(e.url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});return r.status===202?null:r.json();};
function scratch(){const root=mkdtempSync('/tmp/m516-');return {root,write(p,v){const f=join(root,p);mkdirSync(path.dirname(f),{recursive:true});writeFileSync(f,typeof v==='string'?v:JSON.stringify(v));},close(){rmSync(root,{recursive:true,force:true});}};}

test('M516 real verification plugin resolves BB configuration and reads SDK IDs with a new server nonce',async()=>{
 const t=scratch();
 const {bb,harness}=createFakePluginHost({pluginId:'m516-inspect',sdk:{threads:{get:async()=>({id:'thr_live',environmentId:'env_live'})},projects:{get:async()=>({id:'proj_live'})},environments:{get:async()=>({id:'env_live'})}}});
 try{
  verification(bb,'provider_fixture',join(t.root,'calls.ndjson'),t.root);
  const configured=await harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({environment:{path:t.root}}));
  assert.deepEqual(configured.tools.map(t=>t.name),['inspect_bb_context']);assert.deepEqual(configured.skills,[]);
  const result=await harness.behavior.callAgentTool('inspect_bb_context',{nonce:'fresh-nonce'});
  assert.ok(JSON.stringify(result).includes('env_live'));
  const calls=readFileSync(join(t.root,'calls.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.at(-1).nonce,'fresh-nonce');assert.match(calls.at(-1).serverNonce,/^[a-f0-9-]{36}$/);
 }finally{await harness.lifecycle.dispose();t.close();}
});

test('M516 source-backed discovery, schema aliases, project replacement, cwd and user precedence',async()=>{
  const t=scratch();
  try{
    const {source:native,fn}=nativeReference();
    const extract=(start,end)=>{const i=native.indexOf(start),j=native.indexOf(end,i+start.length);assert.ok(i>=0&&j>i);return native.slice(i,j);};
    const c=vm.createContext({$0:path,hP:path,dW:fs,Eka:'.',cb:{Project:'project'},d:z});
    vm.runInContext(['gka','hka','dxo','tAn','Oce','Bwa','$wa','qwa','Svt'].map(fn).join(';'),c);
    vm.runInContext('let '+extract('wvt=d.record(', ',Cwa=d.union(')+';',c);
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify($wa({mcp:{servers:{valid:{command:"node"},invalid:{command:42}}}},[]).mcp.servers)',c)),{valid:{type:'stdio',command:'node'}});
    t.write('repo/.git','gitdir: synthetic');
    t.write('repo/zcode.json',{mcp:{servers:{discarded:{command:'first'},collision:{command:'project'}}}});
    t.write('repo/deep/.zcode/config.json',{mcp:{servers:{collision:{command:'deep',cwd:'relative'},kept:{type:'http',url:'http://fixture'}}}});
    mkdirSync(join(t.root,'repo/deep/child'),{recursive:true});
    const cwd=join(t.root,'repo/deep/child');c.cwd=cwd;
    assert.deepEqual(await api.nativeMcpPaths(cwd),JSON.parse(vm.runInContext('JSON.stringify(dxo(hka(cwd)))',c)));
    const defs=[{command:'node',environment:{A:'B'},enable:false},{type:'remote',url:'http://fixture',http_headers:{X:'Y'}},
      {type:'stdio',command:'node',args:['a'],cwd:'../cwd',timeoutMs:2000,alwaysLoad:true,isolation:'session',protocolVersion:'auto'},
      {type:'http',url:'x',oauth:{type:'authorization_code',clientName:'test'}}, {command:'node',extra:true},null];
    for(const entry of defs){c.entry=entry;const expected=JSON.parse(vm.runInContext('JSON.stringify(Gko.safeParse(entry))',c));
      assert.deepEqual(api.normalizeMcpEntry(entry),expected.success?expected.data:null);}
    c.base={type:'stdio',command:'deep',cwd:'relative'};c.dir=join(t.root,'repo/deep');
    const expectedCwd=vm.runInContext('tAn(base,dir).cwd',c);
    t.write('home/.zcode/cli/config.json',{mcp:{servers:{user:{url:'http://user'}}},plugins:{enabledPlugins:{fixture:true}}});
    const read=await api.readNativeMcp(cwd,join(t.root,'home'));
    assert.equal(read.reason,undefined);assert.deepEqual(read.servers.map(s=>s.name),['collision','kept','user']);
    assert.equal(read.servers[0].cwd,expectedCwd);assert.equal(read.servers[0].scope,'workspace');assert.equal(read.servers[2].scope,'user');
    c.r=value=>value;c.declarations=read.servers;
    vm.runInContext(fn('x6t')+fn('R_c'),c);
    const admission=await vm.runInContext(`(async()=>{
      let granted=false;const connected=[];
      const nativePort={connectConfiguredServers:async map=>{connected.push(...Object.keys(map));},connectServer:async name=>{connected.push(name);},
        status:async()=>({}),listTools:async()=>['collision','kept','user'].map(serverName=>({serverName})),close:async()=>{}};
      const trust={allows:async(_,config)=>config.source?.kind!=='workspace'||granted,inspect:async()=>({})};
      const guarded=R_c(nativePort,trust,{}),runtime=x6t(declarations).servers;
      const blocked=await guarded.connectConfiguredServers(runtime);const before=[...connected];granted=true;await guarded.connectConfiguredServers(runtime);
      await guarded.close();return JSON.stringify({blocked,before,after:connected});
    })()`,c);
    const gate=JSON.parse(admission);assert.deepEqual(gate.before,['user']);assert.equal(gate.blocked.statuses.collision.status,'untrusted');
    assert.deepEqual(gate.blocked.tools,[{serverName:'user'}]);assert.deepEqual(gate.after,['user','user','collision','kept']);
    c.first={priority:20,scope:'project',config:JSON.parse(readFileSync(join(t.root,'repo/zcode.json'),'utf8'))};
    c.last={priority:20,scope:'project',config:JSON.parse(readFileSync(join(t.root,'repo/deep/.zcode/config.json'),'utf8'))};
    assert.deepEqual(read.servers.filter(s=>s.scope==='workspace').map(s=>s.name),JSON.parse(vm.runInContext('JSON.stringify(Object.keys(Oce(first,last).mcp.servers))',c)));
    t.write('home/.zcode/cli/config.json',{mcp:{servers:{collision:{command:'user'}}}});
    assert.equal((await api.readNativeMcp(cwd,join(t.root,'home'))).servers.find(s=>s.name==='collision').command,'user');
    // Outside a repo native ignores ancestor configs.
    mkdirSync(join(t.root,'outside/child'),{recursive:true});c.cwd=join(t.root,'outside/child');
    assert.deepEqual(await api.nativeMcpPaths(c.cwd),JSON.parse(vm.runInContext('JSON.stringify(dxo(hka(cwd)))',c)));
  }finally{t.close();}
});

test('M516 disabled winner/name collision, invalid sibling, unreadable and whole invalid file select no override',async()=>{
 const t=scratch();try{
  const home=join(t.root,'home'),cwd=join(t.root,'work');mkdirSync(cwd);
  for(const config of [{mcp:{servers:{collision:{url:'http://disabled',enabled:false}}}},
    {mcp:{servers:{good:{url:'http://good'},bad:{command:12}}}},'{invalid',[],{hooks:{enabled:false}}]){
   t.write('home/.zcode/cli/config.json',config);
   const result=await api.readNativeMcp(cwd,home);assert.ok(result.reason);assert.equal(result.servers,undefined);
  }
  rmSync(join(home,'.zcode/cli/config.json'));mkdirSync(join(home,'.zcode/cli/config.json'));
  assert.match((await api.readNativeMcp(cwd,home)).reason,/read/);
 }finally{t.close();}
});

test('M516 isolated real SDK bridge protocol kit round trip and cancellation',()=>{
 const result=spawnSync(process.execPath,['tests/provider/m516-protocol-worker.test.mjs'],{encoding:'utf8',env:process.env});
 assert.equal(result.status,0,result.stdout+' '+result.stderr);
 assert.equal(JSON.parse(result.stdout.trim()).passed,true);
});

test('M516 browser Origin is refused before dispatch; tokenless native/local requests still execute',async()=>{
 const calls=[];let endpoint;
 endpoint=new api.BbToolEndpoint([tool],r=>{calls.push(r);endpoint.handleResponse({jsonrpc:'2.0',id:r.id,result:{success:true,contentItems:[{type:'inputText',text:'LOCAL_OK'}]}});},
  ()=>({threadId:'thr_origin',providerThreadId:'native_origin',turnId:null}));
 try{
  await endpoint.listen();
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool.name,arguments:{nonce:'origin-probe'}}});
  for(const origin of ['https://evil.example','null','']) for(const type of ['text/plain','application/json']) {
   const response=await fetch(endpoint.url,{method:'POST',headers:{origin,'content-type':type},body});
   assert.equal(response.status,403);assert.equal(calls.length,0);assert.equal(endpoint.pendingCount,0);
  }
  for(const method of ['GET','DELETE','OPTIONS']) assert.equal((await fetch(endpoint.url,{method,headers:{origin:'https://evil.example'}})).status,403);
  assert.equal(calls.length,0);
  assert.equal((await post(endpoint,'tools/call',{name:tool.name,arguments:{nonce:'native-client'}})).result.content[0].text,'LOCAL_OK');
  assert.equal(calls.length,1);
  const local=await fetch(endpoint.url,{method:'POST',headers:{'content-type':'text/plain'},body});
  assert.equal((await local.json()).result.content[0].text,'LOCAL_OK');assert.equal(calls.length,2);
 }finally{await endpoint.close();}
});

test('M516 MCP server names are stable across attachments and avoid effective configuration collisions',async()=>{
 const identity=()=>({threadId:'thr_names',providerThreadId:'native_names',turnId:null});
 const endpoints=[new api.BbToolEndpoint([tool],()=>{},identity),new api.BbToolEndpoint([tool],()=>{},identity),
  new api.BbToolEndpoint([tool],()=>{},identity,['bb_tools','bb_tools_1']),new api.BbToolEndpoint([tool],()=>{},identity,['bb_tools','bb_tools_1'])];
 try{
  assert.deepEqual(endpoints.map(e=>e.name),['bb_tools','bb_tools','bb_tools_2','bb_tools_2']);
  for(const e of endpoints){await e.listen();assert.equal(e.declaration().name,e.name);}
  assert.notEqual(endpoints[0].url,endpoints[1].url);
 }finally{await Promise.all(endpoints.map(e=>e.close()));}
});

test('M516 actual native UI/plugin writer outputs preserve the MCP set without fallback',async()=>{
 const t=scratch();try{
  const {fn}=nativeReference();
  const c=vm.createContext({p2:'zcode-cua@zcode-plugins-official',fP:'computer-use@zcode-plugins-official',hY:'visualize@zcode-plugins-official',NEn:'visualizeDefaultOffMigrated'});
  vm.runInContext(['yg','Wwe','mY','eka','rxo','tka'].map(fn).join(';'),c);
  const home=join(t.root,'home'),cwd=join(t.root,'work');mkdirSync(cwd);
  c.config={mcp:{servers:{kept:{url:'http://fixture'}}}};
  const expressions=['eka(config,"en-US")','rxo(config,"fixture",true)','tka(config,"fixture",{theme:"blue",enabled:true,count:3},[])',
   '({...config,plugins:{suppressedBuiltins:["fixture"]}})','tka(rxo(eka(config,"zh-CN"),"fixture",false),"fixture",{verbose:true},[])'];
  for(const expression of expressions){
   t.write('home/.zcode/cli/config.json',JSON.parse(vm.runInContext('JSON.stringify('+expression+')',c)));
   const result=await api.readNativeMcp(cwd,home);assert.equal(result.reason,undefined,expression);assert.deepEqual(result.servers.map(s=>s.name),['kept']);
  }
  for(const config of [{ui:{locale:['en-US']}},{ui:{locale:'unsupported'}},{plugins:{options:{fixture:{invalid:[]}}}},
   {plugins:{enabledPlugins:{fixture:1}}},{plugins:{suppressedBuiltins:[42]}},{plugins:{dirs:[]}},
   {ui:{locale:'en-US'},mcp:{servers:{bad:{command:42}}}},{plugins:{options:{fixture:{ok:true}}},mcp:{servers:{off:{url:'http://fixture',enabled:false}}}}]){
   t.write('home/.zcode/cli/config.json',config);assert.ok((await api.readNativeMcp(cwd,home)).reason,JSON.stringify(config));
  }
 }finally{t.close();}
});

test('M516 real bridge construction: empty catalog, endpoint round trip bypass, Stop/release/death and cold resume generation',async()=>{
 const t=scratch(),out=[],observed=[],calls=[],children=[];let ordinal=0,releaseAck;
 const ackGate=new Promise(resolve=>{releaseAck=resolve;});
 const bridge=api.createZCodeBridge({prepare:async()=>({launch:{executable:process.execPath,args:[resolve('tests/provider/fake-v4.mjs'),'v4',join(t.root,'sessions.json')],cwd:t.root,
    env:api.childEnvironment(process.env,{HOME:t.root,ELECTRON_RUN_AS_NODE:process.env.ELECTRON_RUN_AS_NODE})},auth:new api.ReadOnlyAuth(join(t.root,'missing')),configure:async c=>{children.push(c);const request=c.request.bind(c);c.request=(method,params)=>{calls.push({method,params});const result=request(method,params);return params?.type==='sendText'&&params.payload.text==='/zero-before-ack'?result.then(async value=>{await ackGate;return value;}):result;};}}),
   observe:v=>observed.push(v),health:async()=>({}),installation:async()=>({}),models:async()=>({}),validateSelection:async()=>{}},m=>out.push(m));
 const rpc=async(method,params)=>{const id=++ordinal;bridge.handleLine(JSON.stringify({jsonrpc:'2.0',id,method,params}));const r=await until(()=>out.find(m=>m.id===id));assert.equal(r.error,undefined,JSON.stringify(r));return r.result;};
 const construction={threadId:'m516-own',cwd:t.root,instructionMode:'append',dynamicTools:[tool],options};
 try{
  const {providerThreadId}=await rpc('thread/start',construction);const endpoint=observed.find(v=>v.event==='bb-tools-attachment');assert.equal(endpoint.attached,true);
  const native=calls.find(v=>v.method==='session/create');assert.equal(native.params.mcpServers.length,1);
  const e={url:endpoint.endpoint};const result=post(e,'tools/call',{name:tool.name,arguments:{nonce:'fresh'}});
  const reverse=await until(()=>out.find(m=>m.method==='item/tool/call'));
  bridge.handleLine(JSON.stringify({jsonrpc:'2.0',id:reverse.id,result:{success:true,contentItems:[{type:'inputText',text:'real bridge response'}]}}));
  assert.equal((await result).result.content[0].text,'real bridge response');
  const queuedTurn=rpc('turn/start',{threadId:construction.threadId,providerThreadId,clientRequestId:'creq_5555555555',input:[{type:'text',text:'/zero-before-ack'}],options});
  await until(()=>calls.some(c=>c.params?.type==='sendText'&&c.params.payload.text==='/zero-before-ack'));
  const unblocked=post(e,'tools/call',{name:tool.name,arguments:{nonce:'while-turn-queue-awaits'}},11);
  const duringQueue=await until(()=>out.filter(m=>m.method==='item/tool/call').length===2&&out.filter(m=>m.method==='item/tool/call').at(-1));
  bridge.handleLine(JSON.stringify({jsonrpc:'2.0',id:duringQueue.id,result:{success:true,contentItems:[{type:'inputText',text:'reverse bypassed blocked turn queue'}]}}));
  assert.equal((await unblocked).result.content[0].text,'reverse bypassed blocked turn queue');
  releaseAck();await queuedTurn;
  await rpc('turn/start',{threadId:construction.threadId,providerThreadId,clientRequestId:'creq_2222222222',input:[{type:'text',text:'/wait-for-interrupt'}],options});
  const header=await until(()=>JSON.parse(readFileSync(join(t.root,'sessions.json'),'utf8'))[providerThreadId].rows.window.find(r=>r.kind==='turnHeader'&&r.state==='running'));
  await until(()=>observed.some(v=>v.event==='native-state'&&v.rows?.some(row=>row.kind==='turnHeader'&&row.turnId===header.turnId&&row.state==='running')));
  await rpc('turn/steer',{threadId:construction.threadId,providerThreadId,clientRequestId:'creq_3333333333',expectedTurnId:header.turnId,input:[{type:'text',text:'guide'}],options:{...options,model:'GLM-5.3'}});
  assert.equal(observed.filter(v=>v.event==='bb-tools-attachment').length,1);
  assert.deepEqual((await post(e,'tools/list')).result.tools.map(t=>t.name),[tool.name]);
  const pending=post(e,'tools/call',{name:tool.name},2).catch(()=>null);await until(()=>out.filter(m=>m.method==='item/tool/call').length===3);
  await rpc('thread/stop',{threadId:construction.threadId,providerThreadId,activeTurnId:null,intent:'interrupt'});await pending.catch(()=>{});
  assert.ok(out.some(m=>m.method==='notifications/cancelled'));await assert.rejects(fetch(e.url));
  await rpc('thread/resume',{...construction,providerThreadId});
  const second=observed.filter(v=>v.event==='bb-tools-attachment').at(-1);assert.notEqual(second.endpoint,endpoint.endpoint);
  assert.equal(calls.filter(v=>v.method==='session/resume').at(-1).params.mcpServers.at(-1).name,native.params.mcpServers.at(-1).name);
  const stale=out.filter(m=>m.method==='item/tool/call').at(-1);
  bridge.handleLine(JSON.stringify({jsonrpc:'2.0',id:stale.id,result:{success:true,contentItems:[]}}));
  await rpc('thread/stop',{threadId:construction.threadId,providerThreadId,activeTurnId:null,intent:'release'});await assert.rejects(fetch(second.endpoint));
  t.write('.zcode/cli/config.json',{mcp:{servers:{disabled:{url:'http://fixture',enabled:false}}}});
  await rpc('thread/resume',{...construction,providerThreadId});
  assert.equal(calls.filter(v=>v.method==='session/resume').at(-1).params.mcpServers,undefined);
  assert.ok(out.some(m=>m.params?.deltas?.some(d=>d.kind==='provider.warning'&&d.summary.includes('disabled'))));
  await rpc('thread/stop',{threadId:construction.threadId,providerThreadId,activeTurnId:null,intent:'release'});
  await rpc('thread/resume',{...construction,providerThreadId,dynamicTools:[]});
  assert.equal(observed.filter(v=>v.event==='bb-tools-attachment').at(-1).attached,false);
  await rpc('thread/stop',{threadId:construction.threadId,providerThreadId,activeTurnId:null,intent:'release'});
  rmSync(join(t.root,'.zcode/cli/config.json'));
  await rpc('thread/resume',{...construction,providerThreadId});
  const doomed=observed.filter(v=>v.event==='bb-tools-attachment').at(-1);
  const dying=post({url:doomed.endpoint},'tools/call',{name:tool.name},3).catch(()=>null);
  await until(()=>out.filter(m=>m.method==='item/tool/call').length===4);
  process.kill(children.at(-1).nativePid,'SIGKILL');
  await until(()=>out.filter(m=>m.method==='notifications/cancelled').length===2);
  await dying;await assert.rejects(fetch(doomed.endpoint));
  assert.equal(calls.filter(v=>v.method==='session/create').length,1);
  await rpc('thread/stop',{threadId:construction.threadId,providerThreadId,activeTurnId:null,intent:'release'});
  await rpc('thread/resume',{...construction,providerThreadId});
  const closingEndpoint=observed.filter(v=>v.event==='bb-tools-attachment').at(-1);
  const closingCall=post({url:closingEndpoint.endpoint},'tools/call',{name:tool.name},4).catch(()=>null);
  await until(()=>out.filter(m=>m.method==='item/tool/call').length===5);
  await bridge.close();await closingCall;await assert.rejects(fetch(closingEndpoint.endpoint));
  assert.equal(out.filter(m=>m.method==='notifications/cancelled').length,3);
 }finally{releaseAck();await bridge.close();t.close();}
});
