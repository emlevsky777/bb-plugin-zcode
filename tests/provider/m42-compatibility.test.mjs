import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { api } from './helpers.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const tuple={bb:'0.45.0',installedSdk:'0.6.15',declaredSdk:'0.6.15',desktop:'3.14.4',cli:'0.16.9',runtimeSha256:'a'.repeat(64),
 bbArtifactSha256:'b'.repeat(64),sdkArtifactSha256:'c'.repeat(64),platform:'darwin',arch:'arm64',node:'24.20.0'};
const table=[{tuple,pluginRevision:'fixture-only',resultRef:'synthetic-level1',evidenceRef:'public SDK fixture',level:'level1'}];
test('M4.9.1 SDK tuple is recognized and the previously checked tuple remains',()=>{
 const current=api.checkedTuples.find(row=>row.tuple.declaredSdk==='0.6.15');
 assert.ok(current);assert.equal(api.compareCompatibility(current.tuple).known,true);
 assert.equal(current.evidenceRef,'docs/implementation/032-M4.9.1-sdk.md');
 const previous=api.checkedTuples.find(row=>row.tuple.declaredSdk==='0.5.29');
 assert.ok(previous);assert.equal(api.compareCompatibility(previous.tuple).known,true);
});
test('unknown compatibility never masks actual startup/protocol failure or retries create',async()=>{
 const output=[];let prepares=0;
 const b=api.createZCodeBridge({compatibility:()=>api.compareCompatibility({...tuple,bb:null},table),
  prepare:async()=>{prepares++;throw new api.ProtocolError('synthetic-startup-protocol-failure');}},m=>output.push(m));
 b.handleLine(JSON.stringify({jsonrpc:'2.0',id:1,method:'thread/start',params:{threadId:'own',cwd:resolve('.'),instructionMode:'append',
  options:{permissionMode:'full',permissionScope:'full',approvalReviewer:null,permissionEscalation:null}}}));
 for(let n=0;n<100&&!output.some(v=>v.id===1);n++)await delay(10);
 const response=output.find(v=>v.id===1);assert.ok(response.error);assert.match(response.error.message,/synthetic-startup-protocol-failure/);
 assert.match(response.error.message,/bb unknown/);assert.equal(prepares,1);assert.equal(output.some(v=>v.method==='thread/identity'),false);await b.close();
});
test('local exact tuple: known, unknown bb/ZCode/both, SHA mismatch and absent metadata never infer compatibility',()=>{
 assert.equal(api.compareCompatibility(tuple,table).known,true);
 for(const change of [{bb:'99.0.0'},{cli:'99.0.0'},{bb:'99.0.0',cli:'99.0.0'},{runtimeSha256:'d'.repeat(64)},
  {cli:null},{bb:null},{installedSdk:null},{runtimeSha256:null},{sdkArtifactSha256:null}]){
  const result=api.compareCompatibility({...tuple,...change},table);assert.equal(result.known,false);assert.match(result.message,/You can continue/);
 }
 assert.equal(api.compareCompatibility(tuple,[{...table[0],evidenceRef:''}]).known,false);
 assert.equal(api.compareCompatibility(tuple,[{...table[0],level:'pending'}]).known,false);
});
test('unknown SHA allows real fake protocol; health/auth/missing executable retain truth',async()=>{
 const base=resolve(process.env.ZCODE_CONNECTION_TEST_ROOT??'.local/M4.2/offline');mkdirSync(base,{recursive:true});const root=mkdtempSync(base+'/compat-');
 const builtin=root+'/builtin.json';writeFileSync(builtin,'{}','utf8');let installed=true;
 const auth=new api.ReadOnlyAuth(root+'/synthetic-store');auth.read=()=>({apiKey:'SYNTHETIC_ONLY'});
 const runtime=api.createNativeServices(root,{auth,discovery:()=>({installed,supported:false,sha256:'unknown',version:null}),
  compatibility:()=>api.compareCompatibility({...tuple,cli:null},table),paths:{executable:process.execPath,script:resolve('tests/provider/fake-v4.mjs'),builtin},
  configure:async c=>{await c.request('runtime/capabilities',{});}});
 try{
  assert.equal((await runtime.services.models()).models.length,2);
  assert.equal((await runtime.services.health()).health.status,'ready');assert.match((await runtime.services.health()).health.statusMessage,/CLI unknown/);
  assert.equal((await runtime.services.installation()).versionUnsupported,false);
  auth.read=()=>{throw new api.AuthError('unauthenticated');};assert.equal((await runtime.services.health()).health.status,'unauthenticated');
  await assert.rejects(runtime.services.prepare(root,undefined,{threadId:'own'}),api.AuthError);
  installed=false;assert.equal((await runtime.services.health()).health.status,'not_installed');await assert.rejects(runtime.services.models(),api.MissingExecutableError);
 }finally{await runtime.close();rmSync(root,{recursive:true});}
});
