import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from './helpers.mjs';
import { bundleReader } from '../../scripts/provider/compat-level0.mjs';
import vm from 'node:vm';

const key = Buffer.alloc(32, 19);
function seal(value, source = 'os', material = key) {
  const iv = Buffer.alloc(12, 3), cipher = createCipheriv('aes-256-gcm', material, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v2:${source}:${createHash('sha256').update(material).digest('hex').slice(0, 24)}:${[iv, cipher.getAuthTag(), body].map(x => x.toString('base64url')).join('.')}`;
}
test('installed Desktop 4.0.0 seal output decodes with the native envelope/key fingerprint', () => {
  const source = bundleReader('/Applications/ZCode.app')('Contents/Resources/app.asar/out/host/chunk-UXO4Y6UR.js');
  assert.equal(createHash('sha256').update(source).digest('hex'), '22e6e1761b18bce0ff71ce1f9bc933ce47655630e9584e103971a20b1c2e7677', 'Review changed native cipher before updating the fixture');
  const nativeSeal = source.slice(source.indexOf('function rs('), source.indexOf('s(rs,"seal")'));
  assert.ok(nativeSeal.startsWith('function rs('));
  const payload = vm.runInNewContext(`${nativeSeal}; rs('SYNTHETIC_NATIVE_TOKEN', key)`, { Bt: n => Buffer.alloc(n, 8), Qi: 12, rl: createCipheriv, Ji: 'aes-256-gcm', Buffer, key });
  const decode = api.credentialDecoder('/SYNTHETIC/credentials.json', Buffer.alloc(32), {}, () => key.toString('base64url'));
  const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 24);
  assert.equal(decode(`enc:v2:os:${fingerprint}:${payload}`), 'SYNTHETIC_NATIVE_TOKEN');
});
test('Desktop v2 OS envelope reads one key per snapshot, does not initialize or change credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'credential-v2-')), file = join(root, 'credentials.json');
  try {
    writeFileSync(file, JSON.stringify({ token: seal('SYNTHETIC_TOKEN') }));
    const before = readFileSync(file); let calls = 0;
    const decode = api.credentialDecoder(file, Buffer.alloc(32), {}, () => { calls++; return key.toString('base64url'); });
    assert.equal(decode(seal('SYNTHETIC_TOKEN')), 'SYNTHETIC_TOKEN');
    assert.equal(decode(seal('SYNTHETIC_ID')), 'SYNTHETIC_ID');
    assert.equal(calls, 1);
    assert.deepEqual(readFileSync(file), before);
    writeFileSync(`${file}.recovery-generation`, 'SYNTHETIC_RECOVERY');
    assert.equal(decode(seal('SYNTHETIC_NEW')), 'SYNTHETIC_NEW');
    assert.equal(calls, 2);
    assert.throws(() => decode(seal('SYNTHETIC_TOKEN', 'env')), /invalid-store/);
    assert.throws(() => decode(seal('SYNTHETIC_TOKEN', 'os', Buffer.alloc(32, 7))), /invalid-store/);
    assert.throws(() => decode('enc:v3:unsupported'), /invalid-store/);
    assert.throws(() => decode(seal('SYNTHETIC_TOKEN').slice(0, -4)), /invalid-store/);
  } finally { rmSync(root, { recursive: true }); }
});
test('Desktop v2 env envelope uses the existing managed secret without an OS-key request or writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'credential-v2-')), file = join(root, 'credentials.json');
  try {
    const secret = 'SYNTHETIC_MANAGED_SECRET_01234567890123456789';
    writeFileSync(join(root, 'credential-secret'), secret, {mode:0o600});
    const material = createHash('sha256').update(secret).digest();
    const decode = api.credentialDecoder(file, Buffer.alloc(32), {}, () => { throw Error('Must not read OS key'); });
    assert.equal(decode(seal('SYNTHETIC_TOKEN', 'env', material)), 'SYNTHETIC_TOKEN');
    assert.equal(readFileSync(join(root, 'credential-secret'), 'utf8'), secret);
  } finally { rmSync(root, { recursive: true }); }
});
test('OAuth profile identity takes precedence over a retained legacy account identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'credential-v2-')), file = join(root, 'credentials.json');
  try {
    writeFileSync(file, JSON.stringify({ 'account-provider:account:zai-individual-coding-plan:identity': 'SYNTHETIC_OLD',
      'oauth:active_provider': 'zai', 'oauth:zai:access_token': 'SYNTHETIC_TOKEN',
      'oauth:zai:user_info': JSON.stringify({ user_id: 'SYNTHETIC_CURRENT', name: 'Synthetic' }) }));
    assert.equal(new api.ReadOnlyAuth(file).read().oauth.identity, 'SYNTHETIC_CURRENT');
  } finally { rmSync(root, { recursive: true }); }
});

test('OAuth accepts active material without legacy identity, rejects stale material and matches raw/normalized native profiles',()=>{
  const root=mkdtempSync(join(tmpdir(),'oauth-active-')),file=join(root,'credentials.json');
  try {
    const store={'oauth:active_provider':'zai','oauth:zai:access_token':'SYNTHETIC_TOKEN'};
    for(const [profile,id] of [[{id:'NORMAL',username:'Synthetic',displayName:'Synthetic'},'NORMAL'],[{user_id:'RAW',id:'EXTRANEOUS',name:'Synthetic'},'RAW']]) {
      store['oauth:zai:user_info']=JSON.stringify(profile);writeFileSync(file,JSON.stringify(store));
      assert.equal(new api.ReadOnlyAuth(file).read().oauth.identity,id);
    }
    store['oauth:active_provider']='bigmodel';delete store['oauth:zai:user_info'];
    store[`account-provider:${api.accountProviderId}:identity`]='STALE';writeFileSync(file,JSON.stringify(store));
    assert.throws(()=>new api.ReadOnlyAuth(file).read(),/unauthenticated/);
  }finally{rmSync(root,{recursive:true});}
});
test('native secret source precedence and managed modes avoid OS access for missing env material',()=>{
  const root=mkdtempSync(join(tmpdir(),'credential-source-')),file=join(root,'credentials.json'),secretFile=join(root,'credential-secret');
  const secret='SYNTHETIC_MANAGED_SECRET_01234567890123456789',material=createHash('sha256').update(secret).digest();let calls=0;
  const os=()=>{calls++;return key.toString('base64url');};
  try {
    writeFileSync(file,JSON.stringify({token:seal('TOKEN','env',material)}));
    assert.throws(()=>api.credentialDecoder(file,key,{},os)(seal('TOKEN','env',material)),/invalid-store/);assert.equal(calls,0);
    writeFileSync(secretFile,secret,{mode:0o644});chmodSync(secretFile,0o644);
    assert.throws(()=>api.credentialDecoder(file,key,{},os)(seal('TOKEN','env',material)),/invalid-store/);assert.equal(calls,0);
    chmodSync(secretFile,0o600);assert.equal(api.credentialDecoder(file,key,{},os)(seal('TOKEN','env',material)),'TOKEN');
    writeFileSync(file,JSON.stringify({os:seal('OS'),env:seal('TOKEN','env',material)}));
    assert.throws(()=>api.credentialDecoder(file,key,{},os)(seal('TOKEN','env',material)),/invalid-store/);assert.equal(calls,1,'snapshot OS envelope overrides implicit secret');
    writeFileSync(join(root,'credential-source'),'invalid');
    assert.equal(api.credentialDecoder(file,key,{ZCODE_CREDENTIAL_SECRET:secret},os)(seal('TOKEN','env',material)),'TOKEN','explicit override precedes source file');
  }finally{rmSync(root,{recursive:true});}
});
test('one catalogue/health operation stops on shared key failure; next explicit refresh can retry',async()=>{
  const root=mkdtempSync(join(tmpdir(),'credential-denial-')),file=join(root,'credentials.json');let calls=0;
  writeFileSync(file,JSON.stringify({'oauth:active_provider':seal('zai'),'oauth:zai:user_info':seal(JSON.stringify({user_id:'ID',name:'Synthetic'})),'oauth:zai:access_token':seal('TOKEN'),zcodejwttoken:seal('JWT')}));
  const auth=new api.ReadOnlyAuth(file);auth.decode=api.credentialDecoder(file,key,{},()=>{calls++;throw Error('Synthetic denial');});
  const runtime=api.createNativeServices(join(root,'service'),{auth,discovery:()=>({installed:true,supported:true,sha256:'synthetic',version:'synthetic'}),compatibility:()=>({message:null}),configure:async()=>{throw Error('Must not launch');}});
  try {
    await assert.rejects(runtime.services.catalogue(),/invalid-store/);assert.equal(calls,1);
    await assert.rejects(runtime.services.catalogue(),/invalid-store/);assert.equal(calls,2);
    assert.equal((await runtime.services.health()).health.status,'unknown');assert.equal(calls,3);
  }finally{await runtime.close();rmSync(root,{recursive:true});}
});
