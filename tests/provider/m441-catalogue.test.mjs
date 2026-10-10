import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { api } from './helpers.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/m441-catalogue.json',import.meta.url),'utf8'));
const ref=id=>({providerId:api.accountProviderId,modelId:id});
function evolved(){const m=structuredClone(fixture.models[1]);m.ref=ref('GLM-Future');m.label='Native future';m.reasoning={defaultLevel:'medium',levels:[{value:'low'},{value:'medium'},{value:'xhigh'}]};return m;}
test('native schema evolution preserves new model/levels/default; removed preferred and Flash, empty/malformed/default/SDK limits',()=>{
 const future=evolved(),catalogue=[future];
 const mapped=api.mapNativeModels(catalogue,ref('GLM-Future'));
 assert.deepEqual(mapped.map(m=>[m.id,m.isDefault,m.defaultReasoningEffort]),[['GLM-Future',true,'medium']]);
 assert.deepEqual(mapped[0].supportedReasoningEfforts.map(e=>e.reasoningEffort),['low','medium','xhigh']);
 assert.equal(mapped[0].displayName,'Native future');
 assert.equal(api.mapNativeModels([...catalogue,...fixture.models],ref('GLM-Future')).find(m=>m.isDefault).id,'GLM-5.3');
 const disabled=structuredClone(fixture.models[0]);disabled.disabledReason='native model unavailable';
 assert.equal(api.mapNativeModels([disabled,future],ref('GLM-Future'))[0].id,'GLM-Future');
 assert.throws(()=>api.mapNativeModels([disabled],disabled.ref),/empty/);
 disabled.disabledReason=7;assert.throws(()=>api.mapNativeModels([disabled,future],ref('GLM-Future')),/availability/);
 assert.throws(()=>api.mapNativeModels([],ref('GLM-Future')),/empty/);
 assert.throws(()=>api.mapNativeModels(catalogue,ref('gone')),/default unavailable/);
 assert.throws(()=>api.mapNativeModels(catalogue,{providerId:'api',modelId:'GLM-Future'}),/default unavailable/);
 for(const change of [m=>{m.ref.modelId='';},m=>{m.reasoning.defaultLevel='max';},m=>{m.reasoning.levels=[];},m=>{m.reasoning.levels.push({value:'low'});}]){
  const m=evolved();change(m);assert.throws(()=>api.mapNativeModels([m],ref('GLM-Future')));
 }
 assert.throws(()=>api.mapNativeModels([future,future],ref('GLM-Future')),/duplicate/);
 const unknown=evolved();unknown.reasoning={defaultLevel:'native-unknown',levels:[{value:'native-unknown'}]};
 assert.throws(()=>api.mapNativeModels([unknown],ref('GLM-Future')),/unsupported by bb SDK/);
});
test('actual loader uses single unselected create, defaults distinguish explicit missing choice, credential/config/mode refresh and no inference',async()=>{
 const base=resolve(process.env.ZCODE_CONNECTION_TEST_ROOT??'.local/M4.4.1/offline');mkdirSync(base,{recursive:true});
 const root=mkdtempSync(join(base,'evolution-')),builtin=join(root,'builtin.json');writeFileSync(builtin,'{}');
 const auth=new api.ReadOnlyAuth(join(root,'credential.json'));writeFileSync(auth.path,'{}');let reads=0,creates=0,inferences=0,launches=0;
 auth.read=()=>{reads++;return{apiKey:'SYNTHETIC_ONLY'};};
 let models=[evolved()],nativeDefault=ref('GLM-Future');
 const runtime=api.createNativeServices(join(root,'service'),{auth,catalogueCache:true,
  discovery:()=>({installed:true,supported:true,sha256:'synthetic',version:'synthetic'}),paths:{executable:process.execPath,script:resolve('tests/provider/fake-v4.mjs'),builtin},
  configure:async child=>{launches++;await child.request('runtime/capabilities',{});const request=child.request.bind(child);child.request=async(method,p)=>{
   if(method==='session/create'){creates++;assert.equal(p.model,undefined);assert.equal(p.thoughtLevel,undefined);assert.equal(p.firstInput,undefined);return{settings:{model:{available:models,current:nativeDefault}}};}
   if(method==='session/read')throw Error('current-only read cannot bootstrap catalogue');
   if(method==='v4/command'&&p.type==='sendText')inferences++;
   return request(method,p);
  };}});
 try{
  const options=api.executionOptions({permissionMode:'full',permissionScope:'full',approvalReviewer:null,permissionEscalation:null});
  assert.equal(options.model,'');assert.equal(options.reasoning,'');
  assert.deepEqual(await runtime.services.validateSelection(options.model,options.reasoning),{model:'GLM-Future',reasoning:'medium'});
  assert.deepEqual(await runtime.services.validateSelection('GLM-Future','xhigh'),{model:'GLM-Future',reasoning:'xhigh'});
  await assert.rejects(runtime.services.validateSelection('GLM-5.3','max'),/unavailable/);
  await assert.rejects(runtime.services.validateSelection('GLM-5.3','medium'),/unavailable/);
  await assert.rejects(runtime.services.validateSelection('GLM-Future','max'),/unavailable/);
  assert.equal(creates,1);assert.equal(launches,1);assert.equal(inferences,0);
  const before=reads;await runtime.services.models();assert.ok(reads>before);
  models=fixture.models;nativeDefault=fixture.nativeDefault;writeFileSync(auth.path,'{"identity":"synthetic-change"}');
  assert.equal((await runtime.services.validateSelection('','')).model,'GLM-5.3');assert.equal(creates,2);
  await assert.rejects(runtime.services.validateSelection('GLM-Future','medium'),/unavailable/);assert.equal(inferences,0);
  await assert.rejects(runtime.services.validateSelection('GLM-Future','max'),/unavailable/);
  writeFileSync(builtin,'{"nativeChange":true}');await runtime.services.models();assert.equal(creates,3);
  await runtime.services.models(undefined,'cli',1);assert.equal(creates,4);
  const key=join(root,'secrets');mkdirSync(key);writeFileSync(join(key,'backupKey'),'SYNTHETIC_ONLY',{mode:0o600});runtime.setSecretRoot(key);
  await runtime.services.models(undefined,'coding-plan-key',1);assert.equal(creates,5);
 }finally{await runtime.close();rmSync(root,{recursive:true});}
});
test('fresh native header binding accepts catalogue-selected future model and rejects mismatched model/reasoning before credential read',()=>{
 const auth=new api.ReadOnlyAuth('synthetic');let reads=0;auth.read=()=>{reads++;return{apiKey:'SYNTHETIC_ONLY'};};
 const p={providerId:api.accountProviderId,accountAccess:{type:'zhipu-account',mode:'individual-coding-plan',accountType:'zai',entitled:true},modelSelection:{...ref('GLM-Future'),options:{reasoningLevel:'medium'}},sessionId:'own',reason:'model-request',requestId:'own-request',workspace:{workspacePath:'/own',workspaceKey:'/own'}};
 assert.equal(auth.headers(p,'own','/own','GLM-Future','medium').headersApplied,true);assert.equal(reads,1);
 // Installed ZJo/createProviderRuntimeHeadersPort passes only provider/model IDs.
 const nativeShape={...p,modelSelection:ref('GLM-Future')};
 assert.equal(auth.headers(nativeShape,'own','/own','GLM-Future','medium').headersApplied,true);assert.equal(reads,2);
 for(const bad of [{...p,modelSelection:{...p.modelSelection,modelId:'gone'}},{...p,modelSelection:{...p.modelSelection,options:{reasoningLevel:'max'}}},{...p,accountAccess:{...p.accountAccess,entitled:false}},{...p,sessionId:'other'},{...p,workspace:{workspacePath:'/other',workspaceKey:'/other'}}])assert.throws(()=>auth.headers(bad,'own','/own','GLM-Future','medium'));
 assert.equal(reads,2);
});
