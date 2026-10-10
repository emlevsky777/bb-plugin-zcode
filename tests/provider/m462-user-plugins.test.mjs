import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { artifact, plugin } from './helpers.mjs';
const { preparePersonalSettings } = await import(artifact ? '../../dist/personal-settings.js' : '../../src/personal-settings.ts');
const { readUserPlugins, applyUserPlugins, userPluginMetadata } = await import(artifact ? '../../dist/user-plugins.js' : '../../src/user-plugins.ts');
const { nativePaths } = await import(artifact ? '../../dist/runtime.js' : '../../src/runtime.ts');
const { rootsFingerprint, resolveNativeRootsCached, clearRootsCache } = await import(artifact ? '../../dist/native-roots.js' : '../../src/native-roots.ts');
// P1: owner OFF/ON decision + installed CLI0.16.9 native-shaped inline manifest,
// config precedence and mergeRuntimeHooks, documented in M4.6.2-native-semantics.
function fixture() {
  const root = mkdtempSync('/tmp/zcode-m462-'), user = join(root,'user'), cwd = join(root,'cwd'), home = join(root,'own'), data = join(home,'data');
  for (const d of [join(user,'.zcode/cli'),join(cwd,'.zcode/skills/standalone'),join(root,'on/.zcode-plugin'),join(root,'on/skills/demo'),join(root,'on/commands'),join(root,'off/.zcode-plugin')]) mkdirSync(d,{recursive:true});
  writeFileSync(join(root,'on/.zcode-plugin/plugin.json'),JSON.stringify({name:'m462-on',version:'0.0.0',hooks:{UserPromptSubmit:[{hooks:[{type:'command',command:'true'}]}]},mcpServers:{trap:{command:'/usr/bin/false'}}}));
  writeFileSync(join(root,'off/.zcode-plugin/plugin.json'),JSON.stringify({name:'m462-off',version:'0.0.0'}));
  writeFileSync(join(root,'on/skills/demo/SKILL.md'),'---\nname: m462-on-skill\ndescription: fixture\n---\n');
  writeFileSync(join(root,'on/commands/probe.md'),'---\ndescription: fixture\n---\nFixture command');
  writeFileSync(join(cwd,'.zcode/skills/standalone/SKILL.md'),'---\nname: m462-standalone\ndescription: fixture\n---\n');
  writeFileSync(join(user,'.zcode/cli/config.json'),JSON.stringify({plugins:{dirs:[join(root,'on')]}}));
  writeFileSync(join(cwd,'.zcode/config.json'),JSON.stringify({plugins:{dirs:[join(root,'off')],enabledPlugins:{'m462-off@inline':false,'m462-on@inline':true}}}));
  return {root,user,cwd,home,data};
}
function native(f,side,preload) {
  return JSON.parse(execFileSync(nativePaths().executable,['--require',preload,nativePaths().script,'--json',side,'list'],{cwd:f.cwd,encoding:'utf8',env:{PATH:process.env.PATH,HOME:f.home,ELECTRON_RUN_AS_NODE:'1',ZCODE_STORAGE_DIR:f.data,ZCODE_DATA_BASE_DIR:f.data,ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:nativePaths().builtin,ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE:nativePaths().builtin}}));
}
test('M462 native OFF excludes project enable and hooks; ON retains Desktop selection and standalone, sources unchanged',async()=>{
  const f=fixture();
  try {
    const source=readFileSync(join(f.cwd,'.zcode/config.json'));
    const rows=await readUserPlugins(f.cwd,nativePaths(),f.user);
    assert.equal(rows.find(p=>p.name==='m462-on').enabled,true);
    assert.equal(rows.find(p=>p.name==='m462-off').enabled,false);
    preparePersonalSettings(f.home,f.data,f.cwd,f.user);
    const off=applyUserPlugins(f.home,f.data,f.cwd,false,rows);
    const offPlugins=native(f,'plugins',off.preload);
    assert.equal(offPlugins.some(p=>p.source!=='official'),false);
    const offSkills=native(f,'skills',off.preload).skills;
    assert.ok(offSkills.some(p=>p.name==='m462-standalone')); assert.equal(offSkills.some(p=>p.source==='plugin'&&p.scope==='user'),false);
    preparePersonalSettings(f.home,f.data,f.cwd,f.user);
    const on=applyUserPlugins(f.home,f.data,f.cwd,true,rows);
    const loaded=native(f,'plugins',on.preload);
    assert.equal(loaded.find(p=>p.name==='m462-on').enabled,true);
    assert.equal(loaded.find(p=>p.name==='m462-off').enabled,false);
    assert.ok(loaded.find(p=>p.name==='m462-on').hookDetails.length>0);
    assert.equal(loaded.find(p=>p.name==='m462-on').dataPath.startsWith(f.data+'/'),true);
    assert.equal(JSON.parse(readFileSync(join(f.home,'.zcode/cli/config.json'))).mcp.servers['plugin:m462-on:trap'].enabled,false);
    assert.ok(native(f,'skills',on.preload).skills.some(p=>p.name==='m462-on-skill'));
    const commands=native(f,'commands',on.preload).commands;
    assert.ok(commands.some(p=>p.name==='probe'&&p.source==='plugin'));
    assert.deepEqual(readFileSync(join(f.cwd,'.zcode/config.json')),source);
    assert.deepEqual(loaded.filter(p=>p.source==='official').map(p=>[p.id,p.enabled]),offPlugins.filter(p=>p.source==='official').map(p=>[p.id,p.enabled]));
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});
test('M462 menu follows flag and caches plugin paths, detects additions without a restart; A40 symlink cycle is bounded',async()=>{
  const f=fixture();
  try {
    clearRootsCache();
    symlinkSync(join(f.cwd,'.zcode/skills'),join(f.cwd,'.zcode/skills/loop'),'dir');
    assert.equal(rootsFingerprint(f.cwd,f.user),rootsFingerprint(f.cwd,f.user));
    const off=await resolveNativeRootsCached(f.cwd,join(f.root,'catalogue'),undefined,f.user,false);
    assert.equal(off.skills.some(p=>p.fallbackName==='m462-on-skill'),false);
    const on=await resolveNativeRootsCached(f.cwd,join(f.root,'catalogue'),undefined,f.user,true);
    assert.ok(on.skills.some(p=>p.fallbackName==='m462-on-skill'));
    assert.ok(on.commands.some(p=>p.path.endsWith('/on/commands/probe.md')));
    assert.deepEqual(await resolveNativeRootsCached(f.cwd,join(f.root,'catalogue'),undefined,f.user,true,
      {...nativePaths(),executable:join(f.root,'not-a-cli')}),on);
    mkdirSync(join(f.root,'on/skills/late'));writeFileSync(join(f.root,'on/skills/late/SKILL.md'),'---\nname: m462-late\ndescription: fixture\n---\n');
    assert.ok((await resolveNativeRootsCached(f.cwd,join(f.root,'catalogue'),undefined,f.user,true)).skills.some(p=>p.fallbackName==='m462-late'));
  } finally { clearRootsCache();rmSync(f.root,{recursive:true,force:true}); }
});
test('M462 metadata rejects unknown source and duplicate identity; registration defaults off and warns about project hooks',async()=>{
  assert.throws(()=>userPluginMetadata([{source:'future'}]),/Invalid/);
  let schema,registration;
  await plugin({settings:{define:s=>{schema=s;return{get:async()=>({authMode:'cli',catalogueRefresh:0}),onChange(){}}}},providers:{register:p=>{registration=p;}}});
  assert.equal(schema.useZCodePlugins.default,false);assert.match(schema.useZCodePlugins.label,/personal and project/);
  assert.match(schema.useZCodePlugins.description,/automatic hooks.*project hooks/);
  assert.equal(registration.experimental_bridgeOptions.useZCodePlugins,false);
  assert.equal(registration.deriveProviderOptions({settings:{useZCodePlugins:true,useUserMcp:true}}).useUserMcp,false);
});
test('M462 host setting is persistent and changes menus without reloading; options reject user MCP and flag type errors',async()=>{
  const {host,api}=await import('./helpers.mjs');
  const root=mkdtempSync('/tmp/zcode-m462-host-');
  try {
    const ctx={experimental_paths:{dataDir:root,tempDir:root},signal:new AbortController().signal};
    assert.deepEqual(host.experimental_host.handlers.setPluginsEnabled({enabled:true},ctx),{enabled:true});
    assert.equal(JSON.parse(readFileSync(join(root,'plugins-enabled.json'))).enabled,true);
    host.experimental_host.handlers.setPluginsEnabled({enabled:false},ctx);
    assert.equal(JSON.parse(readFileSync(join(root,'plugins-enabled.json'))).enabled,false);
    assert.throws(()=>api.executionOptions({permissionMode:'full',permissionScope:'full',approvalReviewer:null,permissionEscalation:null,providerOptions:{useZCodePlugins:'yes'}}),/plugin setting/);
    assert.throws(()=>api.executionOptions({permissionMode:'full',permissionScope:'full',approvalReviewer:null,permissionEscalation:null,providerOptions:{useUserMcp:true}}),/MCP support/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('M462 initial host synchronization runs after factory; settings replace registration through its disposer',async()=>{
  let factory=true,start,changes,calls=0,registered=false,disposals=0;
  await plugin({settings:{define:()=>({get:async()=>({authMode:'cli',catalogueRefresh:0,useZCodePlugins:true}),onChange:f=>{changes=f;}})},
    providers:{register(){assert.equal(registered,false);registered=true;return{dispose(){assert.equal(registered,true);registered=false;disposals++;}};}},hosts:{experimental_client:()=>({async call(method,input){assert.equal(factory,false);assert.equal(method,'setPluginsEnabled');calls++;return input;}})},
    sdk:{system:{config:async()=>({primaryHostId:'host_fixture'})}},log:{warn(){assert.fail('Unexpected sync failure');}},
    background:{service(name,service){assert.equal(name,'native-plugin-menu-setting');start=service.start;}}});
  assert.equal(calls,0);factory=false;
  const controller=new AbortController();controller.abort();await start(controller.signal);assert.equal(calls,1);
  await changes({authMode:'cli',catalogueRefresh:0,useZCodePlugins:false});assert.equal(calls,2);assert.equal(disposals,1);assert.equal(registered,true);
});
