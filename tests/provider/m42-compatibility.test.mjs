import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { api } from './helpers.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
const tuple={bb:'0.45.0',installedSdk:'0.6.15',declaredSdk:'0.6.15',desktop:'3.14.4',cli:'0.16.9',runtimeSha256:'a'.repeat(64),
 bbArtifactSha256:'b'.repeat(64),sdkArtifactSha256:'c'.repeat(64),platform:'darwin',arch:'arm64',node:'24.20.0'};
const table=[{tuple,pluginRevision:'fixture-only',resultRef:'synthetic-level1',evidenceRef:'public SDK fixture',level:'level1'}];
test('current base reference is exact; only evidenced level1 tuples are accepted and old support is removed',()=>{
 const ref=api.compatibilityReference;
 assert.equal(ref.bb,'0.47.1');assert.equal(ref.installedSdk,'0.6.79');assert.equal(ref.declaredSdk,'0.6.79');
 assert.equal(ref.desktop,'3.15.1');assert.equal(ref.node,'24.22.0');assert.match(ref.builtinSha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(api.checkedTuples.map(row=>row.tuple.bb),['0.47.1','0.48.0']);
 const target=api.checkedTuples[1].tuple;
 assert.equal(target.installedSdk,'0.6.94');assert.equal(target.declaredSdk,'0.6.79');
 assert.equal(target.desktop,'3.16.3');assert.equal(target.cli,'0.17.0');
 assert.equal(api.compareCompatibility({...target,desktop:'3.16.4'}).known,false);
 assert.equal(api.compareCompatibility({...target,node:'24.23.0'}).known,false);
 for(const current of api.checkedTuples){
  assert.equal(api.compareCompatibility(current.tuple).known,current.level==='level1');
  assert.match(current.pluginRevision,/^[a-f0-9]{7,40}$/);
  for(const key of ['runtimeSha256','builtinSha256','sdkArtifactSha256'])assert.equal(api.compareCompatibility({...current.tuple,[key]:'d'.repeat(64)}).known,false);
 }
 assert.equal(api.compareCompatibility(tuple,table).message,null);
});
test('actual installed tuple is discovered without promoting an untested installation to checked support',()=>{
 const paths={script:'/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',executable:'/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper'};
 const current=api.discoverCompatibility(paths,createHash('sha256').update(readFileSync(paths.script)).digest('hex'));
 assert.equal(current.runtimeSha256,createHash('sha256').update(readFileSync(paths.script)).digest('hex'));
 assert.equal(current.declaredSdk,'0.6.79');assert.equal(current.platform,process.platform);assert.equal(current.node,process.versions.node);
 for(const key of ['builtinSha256','bbArtifactSha256','sdkArtifactSha256'])assert.match(current[key],/^[a-f0-9]{64}$/);
 const match=api.checkedTuples.find(row=>Object.entries(current).every(([key,value])=>value!==null&&row.tuple[key]===value));
 const compared=api.compareCompatibility(current);
 assert.equal(compared.known,Boolean(match));
 if(match)for(const [key,value]of Object.entries(current))assert.equal(match.tuple[key],value,key);
 else assert.match(compared.message,/has not been checked/);
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
