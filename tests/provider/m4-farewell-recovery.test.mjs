import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { api, artifact, snapshot, inputs } from './helpers.mjs';
import { experimental_assembleCapturedThreadEvents as assemble } from '@get-bb/plugin-sdk/provider-bridge/testing';
// Own M3 recording fields: m3-native-background fixture; public warning schema/assembler1945.
const state = (command = '/own/node worker.mjs --key SYNTHETIC_SECRET_1') => ({ ...snapshot([
  { rowId: 1, kind: 'turnHeader', turnId: 't', sourceCommandId: 'c', state: 'completedSuccess' },
  { rowId: 2, kind: 'toolCall', turnId: 't', toolCallId: 'tool1', toolName: 'Bash', status: 'success', workId: 'exec-own',
    input: { command, run_in_background: true }, output: { text: 'background task started' } },
]), control: { phase: 'completedSuccess', activeWorks: [] },
 backgroundWorks: [{ workId: 'exec-own', kind: 'bash', title: 'secret title SYNTHETIC_SECRET_1', status: 'running', anchorRowId: 2 }] });
const withRoot = async fn => { const root=mkdtempSync(join(tmpdir(),'m4-task-'));try{await fn(join(root,'tasks.json'));}finally{rmSync(root,{recursive:true});} };
test('crash notice is thread scoped, distinguishes safe command/work, never repairs old card and excludes arguments/title/PID', async () => withRoot(async file => {
  const t=new api.BackgroundTasks('s',()=>{},file);t.baseline(snapshot());t.project(state());
  const bytes=readFileSync(file,'utf8');assert.doesNotMatch(bytes,/SYNTHETIC_SECRET_1|worker.mjs|supervisorPid|pid|lease/);
  assert.match(bytes,/node/);
  const recovered=new api.BackgroundTasks('s',()=>{},file),ds=recovered.baseline(state());
  assert.equal(ds.length,1);assert.equal(ds[0].kind,'provider.warning');assert.match(ds[0].summary,/node/);assert.match(ds[0].details,/exec-own/);
  const ev=assemble([{jsonrpc:'2.0',method:'thread/delta',params:{threadId:'own',deltas:ds}}],'zcode');
  assert.equal(ev[0].type,'provider/warning');assert.equal(ev[0].scope.kind,'thread');
  assert.equal(JSON.parse(readFileSync(file,'utf8')).tasks[0].closed,false);
  recovered.recoveryDelivered();assert.equal(new api.BackgroundTasks('s',()=>{},file).baseline(state()).length,0);
}));
test('legacy v1 PID is ignored and removed, corrupt/session/unknown v2 fields fail visibly', async () => withRoot(async file => {
  const v={version:1,sessionId:'s',supervisorPid:process.pid,tasks:[{workId:'exec-own',key:JSON.stringify(['s','background','exec-own']),closed:false}]};
  writeFileSync(file,JSON.stringify(v));const t=new api.BackgroundTasks('s',()=>{},file);assert.equal(t.baseline(snapshot())[0].kind,'provider.warning');
  t.recoveryDelivered();assert.doesNotMatch(readFileSync(file,'utf8'),/supervisorPid/);
  const clean=JSON.parse(readFileSync(file,'utf8'));
  for(const corrupt of [{...clean,sessionId:'foreign'},{...clean,pid:process.pid},{...clean,tasks:[{...clean.tasks[0],description:'SYNTHETIC_SECRET_1'}]}]){
    writeFileSync(file,JSON.stringify(corrupt));assert.throws(()=>new api.BackgroundTasks('s',()=>{},file),/background-checkpoint-invalid/);
  }
}));
test('failed output retains pending crash marker and successful cleanup alone commits closure', async () => withRoot(async file => {
  const out=[],l=new api.SessionLifecycle('own','s','epoch1',1,()=>{},m=>out.push(m),async()=>1,'/own',file);
  l.baseline(snapshot());const s=state();l.project(s,1,'s',inputs(s.rows.window));
  await assert.rejects(l.stop('interrupt',1,'s'),/owned-resources-remain/);
  const ev=assemble(out,'zcode');assert.equal(ev.filter(e=>e.type==='item/backgroundTask/completed').length,1);
  assert.equal(ev.find(e=>e.type==='item/backgroundTask/completed').item.taskStatus,'killed');
  assert.equal(JSON.parse(readFileSync(file,'utf8')).tasks[0].closed,false);
  const recovered=new api.SessionLifecycle('own','s','epoch1',2,()=>{},()=>{throw Error('output failed');},async()=>0,'/own',file);
  assert.throws(()=>recovered.baseline(s),/output failed/);assert.equal(JSON.parse(readFileSync(file,'utf8')).tasks[0].closed,false);
}));
test('successful farewell closes same task ID before cleanup resolves with one boundary', async () => withRoot(async file => {
  const out=[];let finish;const freed=new Promise(resolve=>{finish=resolve;});
  const l=new api.SessionLifecycle('own','s','epoch1',1,()=>{},m=>out.push(m),()=>freed,'/own',file);
  l.baseline(snapshot());const s=state();l.project(s,1,'s',inputs(s.rows.window));
  const stopped=l.stop('interrupt',1,'s');await delay(0);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).tasks[0].closed,false);
  const ev=assemble(out,'zcode'),open=ev.find(v=>v.item?.type==='backgroundTask'),closed=ev.find(v=>v.type==='item/backgroundTask/completed');
  assert.equal(open.item.id,closed.item.id);assert.equal(closed.item.taskStatus,'killed');
  assert.equal(ev.filter(v=>v.type==='turn/completed').length,1);
  finish(0);await stopped;assert.equal(JSON.parse(readFileSync(file,'utf8')).tasks[0].closed,true);
}));
test('bridge farewell is idempotent and rejects new work during shutdown', async () => {
  const out=[],b=api.createZCodeBridge({},m=>out.push(m));const first=b.close();assert.equal(b.close(),first);await first;
  b.handleLine(JSON.stringify({jsonrpc:'2.0',id:1,method:'provider/health',params:{}}));
  for(let n=0;n<100&&!out.length;n++)await delay(10);
  assert.match(out[0].error.message,/shutting down/);
});
for(const trigger of ['EOF','SIGTERM'])test(`actual host ${trigger} exits after stdout flush, repeated close is harmless`, async () => {
  const hostUrl=new URL(artifact?'../../dist/host.js':'../../src/host.ts',import.meta.url).href;
  const code=`const {experimental_providerBridge:e}=await import(${JSON.stringify(hostUrl)});process.once('SIGTERM',()=>{e.onSigterm();e.onClose();});process.stdin.on('end',e.onClose);process.stdin.resume();process.stdout.write('READY\\n');`;
  const p=spawn(process.execPath,['--input-type=module','-e',code],{env:process.env,stdio:['pipe','pipe','pipe']});let output='',errors='';
  p.stdout.on('data',v=>output+=v);p.stderr.on('data',v=>errors+=v);const exit=once(p,'exit');
  try{for(let n=0;n<200&&!output.includes('READY');n++)await delay(10);assert.match(output,/READY/);
    if(trigger==='EOF')p.stdin.end();else p.kill('SIGTERM');
    const result=await Promise.race([exit,delay(5000).then(()=>{throw Error('host shutdown timeout');})]);
    assert.equal(result[0],0,errors);assert.equal(result[1],null);assert.equal(errors,'');
  }finally{if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');}
});
