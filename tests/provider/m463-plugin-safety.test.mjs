import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { artifact, api } from './helpers.mjs';
const isolation = await import(artifact ? '../../dist/plugin-isolation.js' : '../../src/plugin-isolation.ts');
const { createPluginDiscoveryView } = await import(artifact ? '../../dist/discovery-view.js' : '../../src/discovery-view.ts');
const { readUserPlugins } = await import(artifact ? '../../dist/user-plugins.js' : '../../src/user-plugins.ts');
const { applyUserPlugins } = await import(artifact ? '../../dist/user-plugins.js' : '../../src/user-plugins.ts');
const { preparePersonalSettings } = await import(artifact ? '../../dist/personal-settings.js' : '../../src/personal-settings.ts');
const fixture = () => { const root = mkdtempSync('/tmp/zcode-m463-'); return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }; };
test('M463 shared official cache, independent mutable state per thread and mode; symlink escape rejected before writes', () => {
  const f = fixture();
  try {
    const data = join(f.root, 'data'); mkdirSync(data);
    const homes = ['first', 'second'].map(n => { const p = join(f.root, n); mkdirSync(p); return p; });
    const roots = homes.flatMap(h => [false, true].map(on => isolation.pluginStateStore(h, data, on)));
    assert.equal(new Set(roots).size, 4);
    assert.equal(new Set(roots.map(p => realpathSync(join(p, 'cache')))).size, 1);
    roots.forEach((p, i) => writeFileSync(join(p, 'installed_plugins.json'), String(i)));
    assert.deepEqual(roots.map(p => readFileSync(join(p, 'installed_plugins.json'), 'utf8')), ['0','1','2','3']);
    const outside = join(f.root, 'outside'); mkdirSync(outside); symlinkSync(outside, join(data, 'escaped'));
    assert.throws(() => isolation.ownedDirectory(data, join(data, 'escaped/child')), /conflict/);
    assert.equal(existsSync(join(outside, 'child')), false);
    assert.equal(isolation.pluginStateStore(homes[0], data, false), roots[0]);
  } finally { f.cleanup(); }
});
test('M463 native discovery respects enabled project precedence without network/write attempts; fence rejects attempted network and source writes', async () => {
  const f = fixture();
  try {
    const home = join(f.root, 'owner'), cwd = join(f.root, 'project'), plugin = join(f.root, 'plugin');
    for (const p of [join(home,'.zcode/cli'),join(cwd,'.zcode'),join(plugin,'.zcode-plugin')]) mkdirSync(p,{recursive:true});
    const source = join(home,'.zcode/cli/config.json');
    const userStorage=join(home,'store'),cache=join(userStorage,'cli/plugins/cache/fixture-market/m463-cache/0.0.0'),registryFile=join(userStorage,'cli/plugins/installed_plugins.json');
    mkdirSync(join(cache,'.zcode-plugin'),{recursive:true});
    writeFileSync(join(cache,'.zcode-plugin/plugin.json'),JSON.stringify({name:'m463-cache',version:'0.0.0'}));
    writeFileSync(registryFile,JSON.stringify({version:1,plugins:[{id:'m463-cache@fixture-market',name:'m463-cache',marketplace:'fixture-market',version:'0.0.0',installedAt:new Date(0).toISOString(),scope:'user'}]}));
    const registryBefore=readFileSync(registryFile);
    writeFileSync(source,JSON.stringify({storage:{dir:userStorage},plugins:{dirs:[plugin],enabledPlugins:{'m463-own@inline':false,'m463-cache@fixture-market':false}}}));
    writeFileSync(join(plugin,'.zcode-plugin/plugin.json'),JSON.stringify({name:'m463-own',version:'0.0.0'}));
    writeFileSync(join(cwd,'.zcode/config.json'),JSON.stringify({plugins:{enabledPlugins:{'m463-own@inline':true,'m463-cache@fixture-market':true}},storage:{dir:home}}));
    const before=readFileSync(source), events=[];
    const rows=await readUserPlugins(cwd,api.nativePaths(),home,undefined,e=>events.push(e));
    assert.equal(rows.find(p=>p.name==='m463-own').enabled,true);
    assert.equal(rows.find(p=>p.name==='m463-cache').enabled,true);
    assert.equal(rows.find(p=>p.name==='m463-cache').source,'cache');
    assert.equal(rows.find(p=>p.name==='m463-cache').rootPath,realpathSync(cache));
    assert.deepEqual(readFileSync(registryFile),registryBefore);
    assert.deepEqual(events.map(e=>e.attempts),[[]]);
    assert.deepEqual(readFileSync(source),before);
    assert.deepEqual(readdirSync(join(home,'.zcode/cli')),['config.json']);
    const view=createPluginDiscoveryView(home);
    try {
      for (const code of ["require('node:https').get('https://example.invalid')",`require('node:fs').writeFileSync(${JSON.stringify(source)},'bad')`]) {
        const result=spawnSync(process.execPath,['--require',view.preload,'-e',code],{cwd,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8'});
        assert.notEqual(result.status,0);
      }
      assert.deepEqual(readFileSync(view.attempts,'utf8').trim().split('\n').map(JSON.parse).map(x=>x.kind),['network-attempt','owner-write']);
      assert.deepEqual(readFileSync(source),before);
    } finally { view.cleanup(); }
    const journal=join(dirname(cache),`.${basename(cache)}.transaction.json`);writeFileSync(journal,'{}');
    await assert.rejects(readUserPlugins(cwd,api.nativePaths(),home),/Pending cached plugin transaction/);
    rmSync(journal);
    writeFileSync(source,JSON.stringify({plugins:null}));
    await assert.rejects(readUserPlugins(cwd,api.nativePaths(),home),/Invalid/);
  } finally { f.cleanup(); }
});
test('M463 native official assets stay shared and byte-identical; generated MCP manifests carry only their own preload', () => {
  const f=fixture();
  try {
    const data=join(f.root,'data'),user=join(f.root,'user'),cwd=join(f.root,'project');
    mkdirSync(user);mkdirSync(cwd);
    const plans=['first','second'].map((name,i)=>{const home=join(f.root,name);preparePersonalSettings(home,data,cwd,user);return{home,...applyUserPlugins(home,data,cwd,i===1)};});
    const run=p=>JSON.parse(execFileSync(api.nativePaths().executable,['--require',p.preload,api.nativePaths().script,'--json','plugins','list'],{cwd,encoding:'utf8',env:{PATH:process.env.PATH,HOME:p.home,ELECTRON_RUN_AS_NODE:'1',ZCODE_STORAGE_DIR:data,ZCODE_DATA_BASE_DIR:data,ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:api.nativePaths().builtin,ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE:api.nativePaths().builtin}}));
    run(plans[0]);
    const file=join(data,'cli/plugins/cache/zcode-plugins-official/image-search/0.1.1/.zcode-plugin/plugin.json'),before=readFileSync(file);
    run(plans[1]);assert.deepEqual(readFileSync(file),before);
    for(const[i,p]of plans.entries()){
      const manifest=readFileSync(join(p.pluginStore,'runtime-manifests/image-search/0.1.1/.zcode-plugin/plugin.json'),'utf8');
      assert.ok(manifest.includes(p.preload));assert.equal(manifest.includes(plans[1-i].preload),false);
      assert.equal(before.toString().includes(p.preload),false);
      // The fixture has a known image-search launch; catalogue size is not pinned.
      assert.ok(isolation.assertOfficialLaunchIsolation(p.pluginStore,p.preload).isolatedLaunchServers>0);
      assert.throws(()=>isolation.assertOfficialLaunchIsolation(p.pluginStore,plans[1-i].preload),/disagree/);
    }
    run(plans[0]);assert.deepEqual(readFileSync(file),before);
  } finally {f.cleanup();}
});
test('M463 native direct-hook trust uses own user storage despite project override, remains pending; grants rejected', () => {
  const f=fixture();
  try {
    const home=join(f.root,'home'),cwd=join(f.root,'project'),data=join(f.root,'data'),foreign=join(f.root,'project-storage');
    for(const p of [join(home,'.zcode/cli'),join(cwd,'.zcode'),data])mkdirSync(p,{recursive:true});
    writeFileSync(join(home,'.zcode/cli/config.json'),JSON.stringify({storage:{dir:data},hooks:{enabled:false}}));
    writeFileSync(join(cwd,'.zcode/config.json'),JSON.stringify({storage:{dir:foreign},hooks:{enabled:true,events:{UserPromptSubmit:[{hooks:[{type:'command',command:'/usr/bin/true'}]}]}}}));
    const output=JSON.parse(execFileSync(api.nativePaths().executable,[api.nativePaths().script,'hooks','trust','status','--workspace',cwd,'--json'],{cwd,encoding:'utf8',env:{PATH:process.env.PATH,HOME:home,ELECTRON_RUN_AS_NODE:'1',ZCODE_BUILTIN_PROVIDER_CONFIG_FILE:api.nativePaths().builtin,ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE:api.nativePaths().builtin}}));
    assert.match(JSON.stringify(output),/pending_trust/);
    assert.equal(existsSync(join(foreign,'security/workspace-hook-trust-v1.json')),false);
    assert.equal(existsSync(join(data,'security')),true);
    assert.equal(isolation.assertEmptyWorkspaceTrust(home,data).records,0);
    writeFileSync(join(data,'security/workspace-hook-trust-v1.json'),JSON.stringify({schemaVersion:1,records:[{grant:true}]}));
    assert.throws(()=>isolation.assertEmptyWorkspaceTrust(home,data),/grants/);
    assert.equal(/(?:hooks['"]?\s*,\s*['"]trust['"]?\s*,\s*['"]grant|workspaceHookTrust\/grant)/.test(readFileSync('src/runtime.ts','utf8')),false);
  } finally {f.cleanup();}
});
test('M463 OFF positive native guard rejects bypass, unknown/missing evidence and confirms session authority', async () => {
  const f=fixture();
  try {
    const catalogue={authority:'session',plugins:[{pluginId:'builtin@zcode-plugins-official',name:'builtin',marketplace:'zcode-plugins-official',enabled:true}]};
    const child={child:{exitCode:null,signalCode:null},generation:1,request:async()=>catalogue};
    const event=(hookCount=0,pluginStorageRoot='/own/plugins')=>writeFileSync(join(f.root,'events.jsonl'),[
      {sessionId:'s',event:'bootstrap.app.startup.plugins.completed',context:{hookCount,pluginStorageRoot}},
      {sessionId:'s',event:'bootstrap.app.startup.completed'}].map(JSON.stringify).join('\n'));
    const run=()=>api.verifyNativePluginState(f.root,child,'s','/project','/own/plugins',true,()=>{},30);
    event();await run();
    event(1);await assert.rejects(run(),/disagree/);
    event(0,'/wrong');await assert.rejects(run(),/disagree/);
    event();catalogue.plugins.push({pluginId:'bypass@inline',name:'bypass',marketplace:'inline',enabled:true});await assert.rejects(run(),/non-official/);
    catalogue.plugins.pop();catalogue.authority='workspace';await assert.rejects(run(),/unavailable/);
    writeFileSync(join(f.root,'events.jsonl'),'');await assert.rejects(run(),/unavailable/);
  } finally {f.cleanup();}
});

test('M464 A44 launch counts are unrestricted; empty authority alone permits absent manifests; unsafe launches fail closed', () => {
  const f = fixture();
  const preload = '/own/thread/preload.cjs', empty = { authority: 'session', plugins: [] };
  try {
    assert.deepEqual(isolation.assertOffPluginCatalogue(empty), empty);
    assert.throws(() => isolation.assertOffPluginCatalogue({ plugins: [] }), /unavailable/);
    assert.throws(() => isolation.assertOfficialLaunchIsolation(f.root, preload), /ENOENT/);
    assert.throws(() => isolation.assertOfficialLaunchIsolation(f.root, preload, { authority: 'workspace', plugins: [] }), /ENOENT/);
    assert.throws(() => isolation.assertOfficialLaunchIsolation(f.root, preload, { authority: 'session', plugins: [{}] }), /ENOENT/);
    assert.throws(() => isolation.assertOfficialLaunchIsolation(f.root, preload, { authority: 'session', plugins: null }), /ENOENT/);
    assert.deepEqual(isolation.assertOfficialLaunchIsolation(f.root, preload, empty), { isolatedLaunchServers: 0, warning: 'No official MCP launches found' });
    writeFileSync(join(f.root, 'runtime-manifests'), 'not a directory');
    assert.throws(() => isolation.assertOfficialLaunchIsolation(f.root, preload, empty), /ENOTDIR/);
    rmSync(join(f.root, 'runtime-manifests'));
    const file = join(f.root, 'runtime-manifests/official/1/.zcode-plugin/plugin.json');
    mkdirSync(dirname(file), { recursive: true });
    for (const count of [0, 1, 2, 4, 7]) {
      const mcpServers = Object.fromEntries(Array.from({ length: count }, (_, i) => [`server${i}`, { args: ['--require', preload, 'cli.cjs'] }]));
      writeFileSync(file, JSON.stringify({ mcpServers }));
      assert.equal(isolation.assertOfficialLaunchIsolation(f.root, preload).isolatedLaunchServers, count);
      if (count) {
        mcpServers.server0.args = ['--require', '/foreign/preload.cjs'];
        writeFileSync(file, JSON.stringify({ mcpServers }));
        assert.throws(() => isolation.assertOfficialLaunchIsolation(f.root, preload), /disagree/);
        mcpServers.server0.args = ['cli.cjs'];
        writeFileSync(file, JSON.stringify({ mcpServers }));
        assert.throws(() => isolation.assertOfficialLaunchIsolation(f.root, preload), /disagree/);
      }
    }
    for (const mcpServers of [null, [], 'unknown']) {
      writeFileSync(file, JSON.stringify({ mcpServers }));
      assert.throws(() => isolation.assertOfficialLaunchIsolation(f.root, preload), /unknown/);
    }
    writeFileSync(file, '{');
    assert.throws(() => isolation.assertOfficialLaunchIsolation(f.root, preload), SyntaxError);
  } finally { f.cleanup(); }
});
