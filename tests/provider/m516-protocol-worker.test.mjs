import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {experimental_createBridgeJsonRpcTestHarness as kit} from '@get-bb/plugin-sdk/provider-bridge/testing';
import {api} from './helpers.mjs';
const tool={name:'inspect_bb_context',description:'Inspect BB context',inputSchema:{type:'object',properties:{nonce:{type:'string'}},required:['nonce']},
  presentation:{label:{pending:'Inspecting BB context',completed:'Inspected BB context'},icon:{glyph:'Info'}}};
const options={permissionMode:'full',permissionScope:'full',approvalReviewer:null,permissionEscalation:null,model:'GLM-5.3-Flash',reasoningLevel:'high'};
async function until(fn){for(let i=0;i<1000;i++){const v=fn();if(v)return v;await delay(5);}throw Error('Timed out');}
const post=async(e,method,params={},id=1)=>{const r=await fetch(e.url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});return r.status===202?null:r.json();};
 const requests=[],e=new api.BbToolEndpoint([tool,{...tool,name:'error_fixture'}],r=>{
   requests.push(r);process.stdout.write(JSON.stringify(r)+'\n');
 },()=>({threadId:'thr_fixture',providerThreadId:'native_fixture',turnId:null}));
 const h=kit(line=>e.handleResponse(JSON.parse(line)));
 try{
  await e.listen();assert.equal((await post(e,'initialize',{protocolVersion:'2024-11-05'})).result.capabilities.tools instanceof Object,true);
  assert.deepEqual((await post(e,'tools/list')).result.tools.map(t=>t.name),['inspect_bb_context','error_fixture']);
  const a=post(e,'tools/call',{name:tool.name,arguments:{nonce:'fresh'}},10),b=post(e,'tools/call',{name:'error_fixture'},11);
  await until(()=>requests.filter(r=>r.method==='item/tool/call').length===2);
  const [ra,rb]=requests.filter(r=>r.method==='item/tool/call');
  assert.equal(ra.params.tool,tool.name);assert.equal(ra.params.threadId,'thr_fixture');assert.equal(ra.params.providerThreadId,'native_fixture');
  h.sendRequest('unrelated','unused',{}); // An unrelated request is not a reverse response.
  e.handleResponse({jsonrpc:'2.0',id:rb.id,result:{success:false,contentItems:[{type:'inputText',text:'fixture failure'}]}});
  e.handleResponse({jsonrpc:'2.0',id:ra.id,result:{success:true,contentItems:[{type:'inputText',text:'before'},{type:'inputImage',imageUrl:'data:image/png;base64,aGVsbG8='},{type:'inputText',text:'after'}]}});
  assert.deepEqual((await a).result.content,[{type:'text',text:'before'},{type:'image',mimeType:'image/png',data:'aGVsbG8='},{type:'text',text:'after'}]);
  assert.equal((await b).result.isError,true);
  const pending=post(e,'tools/call',{name:tool.name},12);await until(()=>e.pendingCount===1);
  await fetch(e.url,{method:'POST',body:JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:12}})});
  assert.equal((await pending).result.isError,true);assert.equal(e.pendingCount,0);
  const late=requests.filter(r=>r.method==='item/tool/call').at(-1);
  assert.equal(e.handleResponse({jsonrpc:'2.0',id:late.id,result:{success:true,contentItems:[]}}),false);
  const abort=new AbortController();
  const disconnected=fetch(e.url,{method:'POST',signal:abort.signal,body:JSON.stringify({jsonrpc:'2.0',id:20,method:'tools/call',params:{name:tool.name}})}).catch(()=>null);
  await until(()=>e.pendingCount===1);abort.abort();await disconnected;await until(()=>e.pendingCount===0);
  assert.equal(requests.filter(r=>r.method==='notifications/cancelled').length,2);
  const oldUrl=e.url;await e.close();await assert.rejects(fetch(oldUrl));
 }finally{await e.close();h.restore();}

console.log(JSON.stringify({passed:true}));
