import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { api } from './helpers.mjs';
// Valid PNG, SDK0.6.15 PromptInput and OSS29628c9 server-operations.ts:505–600.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');
const provider=api.accountProviderId;
const options={permissionMode:'full',permissionScope:'full',approvalReviewer:null,permissionEscalation:null,model:'GLM-5.3',reasoningLevel:'max',envVars:{}};
test('A33 native subagent/compact other account model accepts fresh headers; unknown and every binding guard reject without reading',()=>{
 const a=new api.ReadOnlyAuth('synthetic');let reads=0;a.read=()=>({apiKey:'SYNTHETIC_'+(++reads)});
 const p={providerId:provider,accountAccess:{type:'zhipu-account',mode:'individual-coding-plan',accountType:'zai',entitled:true},modelSelection:{providerId:provider,modelId:'Flash'},sessionId:'own',reason:'model-request',requestId:'subagent',workspace:{workspacePath:'/own',workspaceKey:'/own'}};
 for(const requestId of ['subagent','compact'])assert.equal(a.headers({...p,requestId},'own','/own','GLM-5.3','max',['GLM-5.3','Flash']).requestAuth.apiKey,'SYNTHETIC_'+reads);
 assert.equal(reads,2);
 assert.equal(a.headers({...p,modelSelection:{...p.modelSelection,options:{reasoningLevel:'high'}}},'own','/own','GLM-5.3','max',['GLM-5.3','Flash']).headersApplied,true);
 for(const delta of [{providerId:'api'},{accountAccess:{...p.accountAccess,entitled:false}},{accountAccess:{...p.accountAccess,mode:'team-coding-plan'}},{modelSelection:{providerId:'api',modelId:'Flash'}},{modelSelection:{providerId:provider,modelId:'unknown'}},{sessionId:'stale'},{reason:'other'},{requestId:''},{workspace:{workspacePath:'/own',workspaceKey:'/other'}},{workspace:{workspacePath:'/other',workspaceKey:'/own'}}])assert.throws(()=>a.headers({...p,...delta},'own','/own','GLM-5.3','max',['GLM-5.3','Flash']));
 assert.throws(()=>a.headers({...p,modelSelection:{providerId:provider,modelId:'GLM-5.3',options:{reasoningLevel:'high'}}},'own','/own','GLM-5.3','max',['GLM-5.3','Flash']));assert.equal(reads,3);
});
test('exact V4 refs preserve local paths; inline image uses bounded checksum transaction, failed upload aborts before send',async()=>{
 const draft=api.convertAttachments([{type:'image',url:'data:image/png;base64,'+png.toString('base64')}],'/own').attachments;
 const calls=[];const request=async(method,p)=>{calls.push({method,p});if(method.endsWith('/begin'))return{uploadId:p.uploadId,state:'staging',nextChunkIndex:0};if(method.endsWith('/chunk'))return{uploadId:p.uploadId,nextChunkIndex:p.chunkIndex+1};return{ref:'zcode-artifact://own/image'};};
 const refs=await api.createAttachmentRefs(draft,'own',request);assert.deepEqual(refs,[{ref:'zcode-artifact://own/image',fileName:'image-1.png',mime:'image/png',bytes:png.length}]);assert.deepEqual(calls.map(c=>c.method),['v4/attachment/begin','v4/attachment/chunk','v4/attachment/commit']);assert.match(calls[0].p.checksum,/^sha256:[a-f0-9]{64}$/);assert.deepEqual(Buffer.from(calls[1].p.dataBase64,'base64'),png);assert.equal(calls[0].p.sessionId,'own');assert.equal(calls[0].p.uploadId,calls[2].p.uploadId);
 assert.deepEqual(await api.createAttachmentRefs([{kind:'file',filename:'x.txt',mimeType:'text/plain',sizeBytes:10,localPath:'/own/x.txt'}],'own',()=>{throw Error('local refs need no upload');}),[{ref:'/own/x.txt',fileName:'x.txt',mime:'text/plain',bytes:10}]);
 const failed=[];await assert.rejects(api.createAttachmentRefs(draft,'own',async(method,p)=>{failed.push(method);if(method.endsWith('/begin'))return{uploadId:p.uploadId,state:'staging',nextChunkIndex:0};if(method.endsWith('/chunk'))throw Error('synthetic chunk failure');return{};}),/synthetic chunk failure/);assert.deepEqual(failed,['v4/attachment/begin','v4/attachment/chunk','v4/attachment/abort']);
 const big={...draft[0],sizeBytes:600000,dataBase64:Buffer.alloc(600000,65).toString('base64')};calls.length=0;await api.createAttachmentRefs([big],'own',request);assert.equal(calls.filter(c=>c.method.endsWith('/chunk')).length,2);assert.ok(calls.filter(c=>c.method.endsWith('/chunk')).every(c=>Buffer.from(c.p.dataBase64,'base64').length<=512*1024));
});
test('image/localImage/localFile native shape/order/metadata/mixed/attachments-only and errors; confirmed bridged GLM allowed, no-Vision suggests model',()=>{
 const root=mkdtempSync('/tmp/zcode-attachments-'),image=join(root,'sample.png'),file=join(root,'data.txt');writeFileSync(image,png);writeFileSync(file,'UTF-8: \u041f\u0440\u0438\u0432\u0435\u0442');
 try{
 const inputs=[{type:'text',text:'first'},{type:'localImage',path:image},{type:'localFile',path:file,name:'shown.txt',mimeType:'text/plain',sizeBytes:Buffer.byteLength('UTF-8: \u041f\u0440\u0438\u0432\u0435\u0442')},{type:'text',text:'last'},{type:'image',url:'data:image/png;base64,'+png.toString('base64')}];
 const c=api.convertAttachments(inputs,root);assert.equal(c.text,'first\nlast');assert.deepEqual(c.attachments.map(a=>a.kind),['image','file','image']);assert.equal(c.attachments[0].localPath,image);assert.equal(c.attachments[1].filename,'shown.txt');assert.equal(c.attachments[1].sizeBytes,Buffer.byteLength('UTF-8: \u041f\u0440\u0438\u0432\u0435\u0442'));assert.equal(c.attachments[2].dataBase64,png.toString('base64'));assert.deepEqual(c.metadata.map(m=>m.index),[1,2,4]);assert.equal(JSON.stringify(c.metadata).includes(png.toString('base64')),false);
 const damaged=Buffer.from(png);damaged[43]^=1;assert.throws(()=>api.convertAttachments([{type:'image',url:'data:image/png;base64,'+damaged.toString('base64')}],root),/PNG/);
 assert.equal(api.convertAttachments([{type:'image',url:pathToFileURL(image).href}],root).attachments[0].localPath,image);
 assert.equal(api.convertAttachments(inputs.slice(1,3),root).text,'');assert.deepEqual(api.convertAttachments([{type:'text',text:'text-only'}],root).attachments,[]);
 for(const i of [{type:'image',url:'https://invalid.example/x.png'},{type:'image',url:'data:image/jpeg;base64,'+png.toString('base64')},{type:'image',url:'data:image/png;base64,***'},{type:'image',url:'data:image/png;base64,a'},{type:'localImage',path:file},{type:'localFile',path:root},{type:'localFile',path:file,sizeBytes:1},{type:'localFile',path:join(root,'missing')}])assert.throws(()=>api.convertAttachments([i],root));
 writeFileSync(file,Buffer.from([0,255,1]));assert.throws(()=>api.convertAttachments([{type:'localFile',path:file}],root),/UTF-8/);writeFileSync(file,Buffer.alloc(256*1024+1,65));assert.throws(()=>api.convertAttachments([{type:'localFile',path:file}],root),/too large/);
 writeFileSync(image,Buffer.alloc(10*1024*1024+1));assert.throws(()=>api.convertAttachments([{type:'localImage',path:image}],root),/too large/);
 const models=[{model:'GLM-5.3',supportsImage:true},{model:'NoVision',supportsImage:false},{model:'Future-Vision',supportsImage:true}];api.requireImageCapability(models,'GLM-5.3');assert.throws(()=>api.requireImageCapability(models,'NoVision'),/Choose a model with Vision: GLM-5.3, Future-Vision/);assert.throws(()=>api.requireImageCapability([{model:'Unknown'}],'Unknown'),/unknown.*Vision/);
 }finally{rmSync(root,{recursive:true});}
});
test('A36 UTF-8 yaml/ts accepts misleading MIME as native text/plain; byte guards still reject binary and PDF',async()=>{
 const root=mkdtempSync('/tmp/zcode-a36-');
 try{
 for(const [name,mimeType,content] of [['data.yaml','application/yaml','name: \u041f\u0440\u0438\u0432\u0435\u0442\n'],['source.ts','video/mp2t','export const \u043f\u0440\u0438\u0432\u0435\u0442 = 1;\n'],['settings.toml','application/octet-stream','name = "hello"\n'],['script.sh','application/x-sh','#!/bin/sh\necho hello\n'],['label.txt','application/pdf','plain text\n']]){
 const path=join(root,name),bytes=Buffer.from(content);writeFileSync(path,bytes);
 const c=api.convertAttachments([{type:'localFile',path,mimeType}],root);
 assert.equal(c.attachments[0].mimeType,'text/plain');assert.equal(c.metadata[0].mimeType,'text/plain');
 assert.deepEqual(await api.createAttachmentRefs(c.attachments,'own',()=>{throw Error('local text needs no upload');}),[{ref:path,fileName:name,mime:'text/plain',bytes:bytes.length}]);
 }
 for(const [name,bytes] of [['invalid.ts',Buffer.from([0xff])],['nul.yaml',Buffer.from('text\0')],['signature.txt',Buffer.from('%PDF-1.7\n')],['document.pdf',Buffer.from('plain UTF-8')]]){
 const path=join(root,name);writeFileSync(path,bytes);assert.throws(()=>api.convertAttachments([{type:'localFile',path,mimeType:'text/plain'}],root),/UTF-8|PDF/);
 }
 }finally{rmSync(root,{recursive:true});}
});
test('real bridge sends native attachments and text, permits attachments-only; no-Vision/missing/malformed mixed never send',async()=>{
 const base=resolve(process.env.ZCODE_CONNECTION_TEST_ROOT??'.local/M4.4.2/offline');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'bridge-')),image=join(root,'image.png'),file=join(root,'file.txt');writeFileSync(image,png);writeFileSync(file,'private fixture marker');
 const output=[],sent=[],events=[];let supportsImage=true;
 const services={prepare:async()=>({launch:{executable:process.execPath,args:[resolve('tests/provider/fake-v4.mjs')],cwd:root,env:api.childEnvironment(process.env,{ELECTRON_RUN_AS_NODE:process.env.ELECTRON_RUN_AS_NODE})},auth:new api.ReadOnlyAuth('synthetic'),configure:async child=>{await child.request('runtime/capabilities',{});const request=child.request.bind(child);child.request=async(method,p)=>{if(method==='v4/command'&&p.type==='sendText'){for(const a of p.payload.attachments??[]){assert.deepEqual(Object.keys(a).sort(),['bytes','fileName','mime','ref']);assert.equal(typeof a.ref,'string');}sent.push(structuredClone(p));}return request(method,p);};}}),validateSelection:async()=>({model:'GLM-5.3',reasoning:'max'}),models:async()=>({models:[{model:'GLM-5.3',supportsImage},{model:'VisionModel',supportsImage:true}]}),observe:e=>events.push(e)};
 const bridge=api.createZCodeBridge(services,m=>output.push(m));let seq=0;async function rpc(method,params){const id='rpc-'+(++seq);bridge.handleLine(JSON.stringify({jsonrpc:'2.0',id,method,params}));for(let i=0;i<500;i++){const m=output.find(m=>m.id===id);if(m)return m;await delay(10);}throw Error('RPC timeout');}
 let providerThreadId;
 const turn=input=>rpc('turn/start',{threadId:'own',providerThreadId,clientRequestId:'creq_2222222222',input,options,instructionMode:'append',dynamicTools:[],disallowedTools:[]});
 try{
 const started=await rpc('thread/start',{threadId:'own',cwd:root,instructionMode:'append',options,dynamicTools:[],disallowedTools:[]});assert.ok(started.result);providerThreadId=started.result.providerThreadId;
 assert.ok((await turn([{type:'text',text:'hi'},{type:'localImage',path:image},{type:'localFile',path:file}])).result);assert.equal(sent.length,1);assert.equal(sent[0].payload.text,'hi');assert.deepEqual(sent[0].payload.attachments.map(a=>a.mime),['image/png','text/plain']);assert.equal(sent[0].payload.modelSelection.modelId,'GLM-5.3');assert.equal(events.find(e=>e.event==='attachment-input').attachments.length,2);await delay(50);
 assert.ok((await turn([{type:'localFile',path:file,mimeType:'video/mp2t'}])).result);assert.equal(sent[1].payload.text,'');assert.equal(sent[1].payload.attachments[0].mime,'text/plain');await delay(50);
 supportsImage=false;assert.match((await turn([{type:'localImage',path:image}])).error.message,/VisionModel/);
 assert.ok((await turn([{type:'text',text:'do not send'},{type:'localFile',path:join(root,'missing')}])).error);assert.ok((await turn([{type:'image',url:'data:image/png;base64,bad'}])).error);
 writeFileSync(file,Buffer.from([0xff]));assert.match((await turn([{type:'localFile',path:file,mimeType:'text/plain'}])).error.message,/UTF-8/);assert.equal(sent.length,2);
 assert.ok((await turn([{type:'text',text:'regression'}])).result);assert.equal(sent.length,3);assert.equal(sent[2].payload.attachments,undefined);
 }finally{await bridge.close();rmSync(root,{recursive:true});}
});
