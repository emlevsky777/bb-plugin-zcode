import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,renameSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {api} from './helpers.mjs';

test('installation identity cache skips expensive load; replacement, removal and TTL invalidate',()=>{
 const root=mkdtempSync(join(tmpdir(),'m43-cache-')),file=join(root,'runtime');
 let now=0,loads=0;writeFileSync(file,'first');
 const cache=api.createFileIdentityCache([file],()=>({version:++loads}),{now:()=>now});
 try{
  assert.equal(cache().version,1);
  for(let i=0;i<10;i++)assert.equal(cache().version,1);
  for(const at of [61000,200000,29*60000-1]){now=at;assert.equal(cache().version,1);}
  assert.equal(loads,1);
  now=29*60000;assert.equal(cache().version,2);
  writeFileSync(join(root,'replacement'),'other');renameSync(join(root,'replacement'),file);
  assert.equal(cache().version,3);assert.equal(cache().version,3);
  unlinkSync(file);assert.equal(cache().version,4);assert.equal(cache().version,4);
  writeFileSync(file,'restored');assert.equal(cache().version,5);
  writeFileSync(file,'changed in place');assert.equal(cache().version,6);
  assert.throws(()=>api.createFileIdentityCache([file],()=>null,{ttlMs:29*60000+1}));
  for(const ttlMs of [0,-1,NaN,Infinity])assert.throws(()=>api.createFileIdentityCache([file],()=>null,{ttlMs}));
 }finally{rmSync(root,{recursive:true});}
});

test('failed discovery load is retried; same metadata cannot remain trusted past bounded TTL',()=>{
 let now=0,loads=0,fail=true;
 const cache=api.createFileIdentityCache([],()=>{loads++;if(fail)throw Error('actual failure');return loads;},{now:()=>now,ttlMs:5});
 assert.throws(cache,/actual failure/);fail=false;assert.equal(cache(),2);assert.equal(cache(),2);
 now=5;assert.equal(cache(),3);
 fail=true;now=10;assert.throws(cache,/actual failure/);
 fail=false;assert.equal(cache(),5);
 now=0;assert.equal(cache(),6);
});
