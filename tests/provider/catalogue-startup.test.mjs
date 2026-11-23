import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { api, host } from './helpers.mjs';
const bundled='/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json';
const helper='/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper';
// Deterministic newer catalogue derived only from the installed public bundle.
// Rename an existing model everywhere so real native schema validation still runs.
const activeCatalogue=JSON.parse(readFileSync(bundled,'utf8'));
for(const rule of [...activeCatalogue.config.providerConfigRules.templateRules,...activeCatalogue.config.providerConfigRules.providerRules]){
 const ids=rule.config.builtinModelIds;
 if(ids?.includes('GLM-5.3'))ids.unshift('GLM-5.4');
}
activeCatalogue.config.modelConfigRules.modelRules.push(...activeCatalogue.config.modelConfigRules.modelRules
 .filter(rule=>rule.modelMatch.includes('5\\.3'))
 .map(rule=>({...structuredClone(rule),modelMatch:rule.modelMatch.replaceAll('5\\.3','5\\.4')})));
for(const key of ['templateModelRules','builtinProviderModelRules']){
 const rules=activeCatalogue.config.modelConfigRules[key];
 rules.push(...rules.filter(rule=>rule.modelId==='GLM-5.3')
  .map(rule=>({...structuredClone(rule),modelId:'GLM-5.4'})));
}
activeCatalogue.revision=48;
const activeBytes=JSON.stringify(activeCatalogue);
const recorded=JSON.parse(readFileSync(new URL('./fixtures/bb-real-inputs.json',import.meta.url),'utf8')).fixtures[0].request;
function fixture() {
 const home=realpathSync(mkdtempSync('/tmp/zcode-startup-')),root=join(home,'service');
 const active=api.desktopBuiltinPath(bundled,'4.0.0',{},home);
 const put=value=>{mkdirSync(dirname(active),{recursive:true});writeFileSync(active,value);};put(activeBytes);
 const make=(executable=helper)=>{
  const auth=new api.ReadOnlyAuth(join(home,'credentials.json'));auth.read=()=>({apiKey:'SYNTHETIC_ONLY',generation:1});
  return api.createNativeServices(root,{auth,personalHome:home,paths:{executable,script:'/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',builtin:bundled},discovery:()=>({installed:true,supported:true,sha256:'startup-test',version:'0.18.0'}),compatibility:()=>({message:null})});
 };
 const start=async(runtime,model='GLM-5.4',mutation,retry)=>{
  const output=[],validate=runtime.services.validateSelection;
  runtime.services.validateSelection=async(...args)=>{const selected=await validate(...args);mutation?.();return selected;};
  const bridge=host.createZCodeBridge(runtime.services,m=>output.push(m));
  try {
   bridge.handleLine(JSON.stringify({jsonrpc:'2.0',id:1,method:'thread/start',params:{...recorded.params,threadId:'startup-case',cwd:home,dynamicTools:[],disallowedTools:[],options:{...recorded.params.options,model,reasoningEffort:'high',envVars:{}}}}));
   const end=Date.now()+30000;
   while(!output.some(m=>m.id===1)&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
   const response=output.find(m=>m.id===1);assert.ok(response,'thread/start response');
   if(retry){
    assert.ok(response.error);retry();runtime.services.validateSelection=validate;
    bridge.handleLine(JSON.stringify({jsonrpc:'2.0',id:2,method:'thread/start',params:{...recorded.params,threadId:'startup-case',cwd:home,dynamicTools:[],disallowedTools:[],options:{...recorded.params.options,model,reasoningEffort:'high',envVars:{}}}}));
    const end=Date.now()+30000;
    while(!output.some(m=>m.id===2)&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
    assert.ok(output.find(m=>m.id===2)?.result,JSON.stringify(output));
   }
   return {response,output};
  }finally{await bridge.close();runtime.services.validateSelection=validate;}
 };
 return {home,root,active,put,make,start,cleanup:()=>rmSync(home,{recursive:true,force:true})};
}
test('ordinary models and thread/start recover active-only model after one startup failure without invalidation',async()=>{
 const f=fixture(),wrapper=join(f.home,'helper');
 writeFileSync(wrapper,`#!/bin/sh\nif [ ! -e '${f.home}/once' ]; then touch '${f.home}/once'; exit 75; fi\nexec '${helper}' "$@"\n`,{mode:0o755});
 let runtime=f.make(wrapper);
 try {
  const first=await runtime.services.models();assert.ok(!first.models.some(m=>m.model==='GLM-5.4'));
  assert.equal(existsSync(join(f.root,'catalogue-v3-coding-plan.json')),false,'unvalidated fallback not persisted');
  const next=await runtime.services.models();assert.ok(next.models.some(m=>m.model==='GLM-5.4'));
  const result=await f.start(runtime);assert.ok(result.response.result,JSON.stringify(result.response));
  await runtime.close();runtime=f.make(wrapper);
  assert.ok((await runtime.services.models()).models.some(m=>m.model==='GLM-5.4'));
  assert.equal(readFileSync(f.active,'utf8'),activeBytes);
 }finally{await runtime.close();f.cleanup();}
});
test('known deferred create rejection clears pending and recovers the same thread after service recreation',async()=>{
 for(const recreate of [false,true]){
  const f=fixture();let runtime=f.make();
  try {
   await runtime.services.models();
   const failed=await f.start(runtime,'GLM-5.4',()=>unlinkSync(f.active));
   assert.match(failed.response.error.message,/working ZCode catalogue/);
   assert.equal(failed.output.some(m=>m.method==='thread/identity'),false);
   const bindingFile=join(api.sessionDataDir(f.root,f.home,'startup-case'),'bb-binding.json');
   assert.deepEqual(JSON.parse(readFileSync(bindingFile,'utf8')),{threadId:'startup-case',cwd:f.home,nativeSessionId:null});
   f.put(activeBytes);
   if(recreate){await runtime.close();runtime=f.make();}
   const recovered=await f.start(runtime);
   assert.ok(recovered.response.result,JSON.stringify(recovered.response));
   assert.equal(JSON.parse(readFileSync(bindingFile,'utf8')).nativeSessionId,recovered.response.result.providerThreadId);
  }finally{await runtime.close();f.cleanup();}
 }
});
test('known local rejection allows retry on the same bridge',async()=>{
 const f=fixture(),runtime=f.make();
 try{await runtime.services.models();await f.start(runtime,'GLM-5.4',()=>unlinkSync(f.active),()=>f.put(activeBytes));}
 finally{await runtime.close();f.cleanup();}
});
test('working startup reconciles removal, invalid data and downgrade; model validation uses actual process',async()=>{
 for(const state of ['absent','invalid','older'])for(const model of ['GLM-5.3','GLM-5.4']){
  const f=fixture(),runtime=f.make();
  try {
   await runtime.services.models();
   const mutation=()=>state==='absent'?unlinkSync(f.active):f.put(state==='invalid'?'{}':JSON.stringify({...JSON.parse(activeBytes),revision:43}));
   const result=await f.start(runtime,model,mutation);
   if(model==='GLM-5.3')assert.ok(result.response.result,JSON.stringify(result.response));
   else {assert.ok(result.response.error,JSON.stringify(result.response));assert.match(result.response.error.message,/working ZCode catalogue/);}
   const events=readFileSync(join(f.root,'service-evidence.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
   assert.ok(events.some(e=>e.event==='builtin-working-selection'&&e.selected===bundled&&e.revision.includes(':44:')));
   assert.ok(events.filter(e=>e.event==='builtin-startup-cleanup').every(e=>e.remaining===0));
  }finally{await runtime.close();f.cleanup();}
 }
});
