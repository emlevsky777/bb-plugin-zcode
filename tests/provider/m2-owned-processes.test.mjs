import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { api, artifact } from './helpers.mjs';
const { ownedDescendantProgram } = await import(artifact ? '../../dist/owned-descendants.js' : '../../src/owned-descendants.ts');
const { OwnedDescendants, parseOwnedInventory } = runInNewContext(ownedDescendantProgram + '\n({OwnedDescendants,parseOwnedInventory})');
const row = (pid, parent, group, started = 'Mon Oct 5 12:00:00 2026', command = 'own-node') => ({ pid, parent, group, started, command, state: 'S' });
test('owned descendant identity follows observed ancestry; PID reuse, foreign processes and orphan exec do not grant signals', () => {
  const registry = new OwnedDescendants(10), rows = new Map([[11,row(11,10,10)], [12,row(12,11,12)], [13,row(13,1,13)]]);
  registry.observe(rows,11,true); assert.equal(registry.escaped(rows).live.length,1);
  rows.set(12,row(12,1,12)); registry.observe(rows,11,true);
  assert.equal(registry.escaped(rows).live[0].pid,12);
  rows.set(12,row(12,1,12,undefined,'changed-program')); registry.observe(rows,11,true);
  assert.equal(registry.escaped(rows).live.length,0); assert.equal(registry.escaped(rows).unknown,true);
  rows.set(12,row(12,1,12,'Mon Oct 5 12:00:01 2026')); registry.observe(rows,11,true);
  assert.equal(registry.escaped(rows).live.length,0); assert.equal(registry.escaped(rows).unknown,false);
  assert.equal(registry.known.has(13),false);
  assert.throws(()=>parseOwnedInventory('unknown inventory',0));
  const parsed = parseOwnedInventory('11 10 10 S Mon Oct  5 12:00:00 2026 own-node\n99 10 10 R Mon Oct  5 12:00:00 2026 ps',99);
  assert.equal(parsed.size,1);
});
test('macOS transient ? state is per-identity unknown: no adoption/signals/settlement inference, unrelated rows remain usable',()=>{
 const parsed=parseOwnedInventory('11 10 10 S Mon Oct  5 12:00:00 2026 own-node\n12 11 12 SNs Mon Oct  5 12:00:00 2026 own-node\n99 1 99 ?Es Mon Oct  5 12:00:00 2026 unrelated',0);
 const registry=new OwnedDescendants(10);registry.observe(parsed,11,true);assert.equal(registry.escaped(parsed).live[0].pid,12);assert.equal(registry.known.has(99),false);
 parsed.set(12,{...parsed.get(12),state:'?N',parent:1});registry.observe(parsed,11,true);
 assert.equal(registry.escaped(parsed).live.length,0);assert.equal(registry.escaped(parsed).unknown,true);
 parsed.set(13,{...row(13,11,13),state:'?N'});registry.observe(parsed,11,true);assert.equal(registry.known.has(13),false);
 parsed.set(12,{...parsed.get(12),state:'SNs'});registry.observe(parsed,11,true);assert.equal(registry.escaped(parsed).live[0].pid,12);
 assert.throws(()=>parseOwnedInventory('99 1 99 Q Mon Oct  5 12:00:00 2026 own-node',0));
});
const base = resolve(process.env.ZCODE_CONNECTION_TEST_ROOT ?? '.local/M2/offline'); mkdirSync(base,{recursive:true});
const fake = resolve('tests/provider/fake-v4.mjs');
const wait = async predicate => { for(let i=0;i<800;i++){if(predicate())return;await delay(10);}throw Error('own process fixture timeout'); };
const absent = pid => {try{process.kill(pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}};
for(const fault of ['release','native-crash']) test('supervisor settles registered detached TERM-ignore process: '+fault+'; unrelated neighbor survives',async()=>{
  const cwd=mkdtempSync(base+'/descendants-'),file=cwd+'/owned.json';
  const neighbor=spawn(process.execPath,[fake,'hang',cwd+'/foreign'],{detached:true,stdio:'ignore',env:process.env});
  const native=new api.NativeProcess({executable:process.execPath,args:[fake,'detached-descendant',file],cwd,
    env:api.childEnvironment(process.env,{ELECTRON_RUN_AS_NODE:process.env.ELECTRON_RUN_AS_NODE})},1,null,()=>{},()=>{});
  let pid;
  try{
    await wait(()=>existsSync(file));pid=JSON.parse(readFileSync(file,'utf8')).pid;
    await wait(()=>native.ownedDescendantPids.has(pid));
    if(fault==='native-crash')process.kill(native.nativePid,'SIGKILL');
    assert.equal(await native.close(),0);await wait(()=>absent(pid));
    assert.equal(absent(neighbor.pid),false);
    assert.ok(native.cleanupObservations.some(p=>p.code==='ESRCH'));
  }finally{
    await native.close().catch(()=>{});
    // A failed readiness assertion may precede adoption; keep ownership data
    // until the completed fixture publication can be read for own cleanup.
    if(!pid&&existsSync(file))pid=JSON.parse(readFileSync(file,'utf8')).pid;
    if(pid&&!absent(pid))process.kill(pid,'SIGKILL');
    neighbor.kill('SIGKILL');await new Promise(r=>neighbor.once('close',r));rmSync(cwd,{recursive:true});
  }
});
test('actual bridge SIGKILL leaves the live supervisor able to settle a registered detached process',async()=>{
  const cwd=mkdtempSync(base+'/bridge-descendants-');
  const bridge=spawn(process.execPath,[resolve('tests/provider/m2-owned-process-worker.mjs'),cwd],{stdio:['pipe','ignore','pipe'],env:process.env});
  let error='';bridge.stderr.on('data',b=>{error+=b;});const done=new Promise(r=>bridge.on('close',r));let owned;
  try{
    await wait(()=>existsSync(cwd+'/ready.json'));owned=JSON.parse(readFileSync(cwd+'/ready.json','utf8'));
    bridge.kill('SIGKILL');await done;
    await wait(()=>absent(owned.escapedPid)&&api.classifyOwnedGroup(owned.groupPid)==='absent');
    assert.equal(error,'');
  }finally{
    bridge.kill('SIGKILL');await done;
    if(owned&&!absent(owned.escapedPid))process.kill(owned.escapedPid,'SIGKILL');
    rmSync(cwd,{recursive:true});
  }
});
test('unverified orphan identity makes cleanup visibly fail even after the primary group disappears',async()=>{
  const cwd=mkdtempSync(base+'/unknown-descendant-'),file=cwd+'/owned.json';
  const native=new api.NativeProcess({executable:process.execPath,args:[fake,'detached-changing',file],cwd,
    env:api.childEnvironment(process.env,{ELECTRON_RUN_AS_NODE:process.env.ELECTRON_RUN_AS_NODE})},1,null,()=>{},()=>{});let pid;
  try{
    await wait(()=>existsSync(file));pid=JSON.parse(readFileSync(file,'utf8')).pid;
    await wait(()=>native.ownedDescendantPids.has(pid));
    await assert.rejects(native.close(),e=>e instanceof api.ProcessCleanupError&&e.stage==='descendants');
    assert.equal(absent(pid),false,'runtime must not signal an identity that no longer matches');
    assert.equal(api.classifyOwnedGroup(native.child.pid),'absent');
  }finally{
    await native.close().catch(()=>{});
    if(pid&&!absent(pid)){
      const current=spawnSync('lsof',['-a','-p',String(pid),'-d','cwd','-Fn'],{encoding:'utf8'});
      assert.equal(current.status,0);assert.ok(current.stdout.split('\n').includes('n'+cwd));
      process.kill(pid,'SIGKILL');await wait(()=>absent(pid));
    }
    rmSync(cwd,{recursive:true});
  }
});
