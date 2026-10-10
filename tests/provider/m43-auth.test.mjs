import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,chmodSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {api,plugin} from './helpers.mjs';
const provider='account:zai-individual-coding-plan';
function store(identity,key){return JSON.stringify({['account-provider:'+provider+':identity']:identity,
 ['account-provider:coding-plan:'+provider+':account:'+encodeURIComponent(identity)+':api-key']:key});}
const params={providerId:provider,accountAccess:{type:'zhipu-account',mode:'individual-coding-plan',accountType:'zai',entitled:true},
 modelSelection:{providerId:provider,modelId:'GLM-5.3'},sessionId:'own',reason:'model-request',requestId:'req1',workspace:{workspacePath:'/own',workspaceKey:'/own'}};
test('CLI rotation and explicit native secret source are fresh, isolated, read-only, without fallback',()=>{
 const root=mkdtempSync(join(tmpdir(),'m43-auth-')),cli=join(root,'credentials.json'),key=join(root,'backupKey');
 writeFileSync(cli,store('first','SYNTHETIC_M43_OLD'));writeFileSync(key,'SYNTHETIC_M43_EXPLICIT',{mode:0o600});
 const auth=new api.ReadOnlyAuth(cli).fork('cli',key);
 try{
  const old=readFileSync(cli);assert.equal(auth.headers(params,'own','/own','GLM-5.3').requestAuth.apiKey,'SYNTHETIC_M43_OLD');assert.deepEqual(readFileSync(cli),old);
  writeFileSync(cli,store('other','SYNTHETIC_M43_NEW'));const fresh=readFileSync(cli);
  assert.equal(auth.headers(params,'own','/own','GLM-5.3').requestAuth.apiKey,'SYNTHETIC_M43_NEW');
  auth.setMode('coding-plan-key');assert.equal(auth.headers(params,'own','/own','GLM-5.3').requestAuth.apiKey,'SYNTHETIC_M43_EXPLICIT');
  unlinkSync(cli);assert.equal(auth.read().apiKey,'SYNTHETIC_M43_EXPLICIT','explicit source never tries CLI');
  chmodSync(key,0o644);assert.throws(()=>auth.read(),e=>e instanceof api.AuthError&&e.kind==='invalid-store');chmodSync(key,0o600);
  unlinkSync(key);assert.throws(()=>auth.read(),e=>e.kind==='missing-key');
  writeFileSync(cli,fresh);symlinkSync(cli,key);assert.throws(()=>auth.read(),e=>e.kind==='invalid-store');unlinkSync(key);
  auth.setMode('cli');assert.equal(auth.headers(params,'own','/own','GLM-5.3').requestAuth.apiKey,'SYNTHETIC_M43_NEW');
  assert.deepEqual(readFileSync(cli),fresh);
  writeFileSync(cli,'{ broken');assert.throws(()=>auth.read(),e=>e.kind==='invalid-store');
  assert.throws(()=>auth.headers({...params,providerId:'zai-api'},'own','/own','GLM-5.3'),e=>e.kind==='unsupported-mode');
 }finally{rmSync(root,{recursive:true});}
});
test('declared native settings forward public source/refresh/plugin flags; change re-registers without exposing secret',async()=>{
 const calls=[];let change;const values={authMode:'cli',catalogueRefresh:0,backupKey:'SYNTHETIC_M43_SECRET'};
 await plugin({settings:{define:descriptors=>{assert.equal(descriptors.backupKey.secret,true);return{get:async()=>values,onChange:fn=>change=fn};}},providers:{register:v=>calls.push(v)}});
 assert.equal(JSON.stringify(calls).includes(values.backupKey),false);
 assert.deepEqual(calls[0].deriveProviderOptions({settings:values}),{authMode:'cli',catalogueRefresh:0,useZCodePlugins:false,useUserMcp:false,providerSubagentsEnabled:true});
 await change({...values,authMode:'coding-plan-key',catalogueRefresh:1});
 assert.deepEqual(calls.at(-1).experimental_bridgeOptions,{authMode:'coding-plan-key',catalogueRefresh:0,useZCodePlugins:false,useUserMcp:false});
 assert.equal(JSON.stringify(calls).includes(values.backupKey),false);
});
test('health checks compatibility once and preserves installation/auth failure guards',async()=>{
 let n=0,installed=true;const auth=new api.ReadOnlyAuth('/synthetic');auth.read=()=>({apiKey:'SYNTHETIC_M43'});
 const runtime=api.createNativeServices('/synthetic',{auth,discovery:()=>({installed,supported:false,sha256:null,version:null}),compatibility:()=>{n++;return{message:'unknown fixture'};}});
 try{assert.equal((await runtime.services.health()).health.status,'ready');assert.equal(n,1);
  auth.read=()=>{throw new api.AuthError('invalid-store');};assert.equal((await runtime.services.health()).health.status,'unknown');
  installed=false;assert.equal((await runtime.services.health()).health.status,'not_installed');assert.equal(n,2);
 }finally{await runtime.close();}
});
