import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,symlinkSync,rmSync,readlinkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {artifact} from './helpers.mjs';
const api=await import(artifact?'../../dist/personal-settings.js':'../../src/personal-settings.ts');
function fixture(){const root=mkdtempSync('/tmp/zcode-m46-'),user=join(root,'user'),own=join(root,'own'),data=join(root,'data'),cwd=join(root,'cwd');for(const p of [join(user,'.zcode/cli'),join(user,'.agents/skills/example'),cwd])mkdirSync(p,{recursive:true});writeFileSync(join(user,'.agents/skills/example/SKILL.md'),'---\nname: example\ndescription: fixture\n---\nOriginal content\n');return{root,user,own,data,cwd,file:join(user,'.zcode/cli/config.json')};}
test('M46 personal roots remain original source; supported config projected and protected fields excluded, refresh is read-only',()=>{
 const f=fixture();try{
 const source={skills:{roots:['~/other-skills','relative'],metadataBudget:600},skill:{'/fixture/disabled.md':{enable:false}},storage:{dir:'/shared',sessionDbPath:'/shared/db'},permission:{mode:'plan'},memory:{use:true},provider:{apiKey:'SYNTHETIC_PRIVATE'},network:{httpProxy:'http://invalid'},hooks:{enabled:true}};
 writeFileSync(f.file,JSON.stringify(source));const before=readFileSync(f.file),body=readFileSync(join(f.user,'.agents/skills/example/SKILL.md'));
 let p=api.preparePersonalSettings(f.own,f.data,f.cwd,f.user);
 assert.deepEqual(p.warnings,[]);assert.equal(p.config.storage.dir,f.data);assert.equal(p.config.storage.sessionDbPath,undefined);assert.equal(p.config.permission.mode,'yolo');assert.equal(p.config.memory.use,false);assert.equal(p.config.hooks.enabled,false);assert.equal(p.config.provider,undefined);assert.equal(p.config.network,undefined);
 assert.deepEqual(p.config.skills.roots,[join(f.user,'other-skills'),join(f.cwd,'relative')]);assert.deepEqual(p.config.skill,source.skill);
 assert.equal(readlinkSync(join(f.own,'.agents/skills')),join(f.user,'.agents/skills'));assert.equal(realpathSync(join(f.own,'.agents/skills/example/SKILL.md')),realpathSync(join(f.user,'.agents/skills/example/SKILL.md')));assert.deepEqual(readFileSync(f.file),before);assert.deepEqual(readFileSync(join(f.user,'.agents/skills/example/SKILL.md')),body);
 writeFileSync(f.file,JSON.stringify({skills:{enabled:false}}));p=api.preparePersonalSettings(f.own,f.data,f.cwd,f.user);assert.equal(p.config.skills.enabled,false);
 }finally{rmSync(f.root,{recursive:true});}
});
test('M46 optional malformed/missing/unsupported personal config falls back with bounded warning; original files untouched',()=>{
 const f=fixture();try{
 assert.deepEqual(api.readPersonalSettings(f.cwd,f.user),{config:{},warnings:[]});
 for(const body of ['{bad','[]',JSON.stringify({skills:'wrong'}),JSON.stringify({skills:{roots:[1]}}),JSON.stringify({skill:[]}),JSON.stringify({skills:{unknownField:true}}),Buffer.from([255])]){
 writeFileSync(f.file,body);const before=readFileSync(f.file);const p=api.preparePersonalSettings(f.own,f.data,f.cwd,f.user);assert.equal(p.warnings.length,1);assert.equal(p.warnings[0],api.personalSettingsWarning);assert.deepEqual(readFileSync(f.file),before);assert.equal(p.config.storage.dir,f.data);
 }
 unlinkSync(f.file);mkdirSync(f.file);assert.equal(api.readPersonalSettings(f.cwd,f.user).warnings.length,1);
 }finally{rmSync(f.root,{recursive:true});}
});
test('M46 config parent symlink conflict cannot write personal config, owned source links reconcile disappearance',()=>{
 const f=fixture();try{
 api.preparePersonalSettings(f.own,f.data,f.cwd,f.user);rmSync(join(f.user,'.agents/skills'),{recursive:true});api.preparePersonalSettings(f.own,f.data,f.cwd,f.user);
 rmSync(join(f.own,'.zcode/cli'),{recursive:true});symlinkSync(join(f.user,'.zcode/cli'),join(f.own,'.zcode/cli'),'dir');writeFileSync(f.file,'SYNTHETIC_KEEP');assert.throws(()=>api.preparePersonalSettings(f.own,f.data,f.cwd,f.user),/directory conflict/);assert.equal(readFileSync(f.file,'utf8'),'SYNTHETIC_KEEP');
 }finally{rmSync(f.root,{recursive:true});}
});
