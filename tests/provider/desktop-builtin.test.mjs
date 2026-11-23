import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {api} from './helpers.mjs';
import {nativeReference} from './native-reference.mjs';

test('real Desktop app-server selects one valid catalogue for models and launch without shared-file repair',async()=>{
  nativeReference();
  const bundled='/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json';
  const release=JSON.parse(readFileSync(bundled,'utf8'));
  const cases=[['newer',{...release,revision:48},48],['older',{...release,revision:43},44],['absent',null,44],['invalid',{},44],
    ['invalid-provider',{...release,revision:50,config:{...release.config,providerConfigRules:{bad:true}}},44],
    ['invalid-model',{...release,revision:51,config:{...release.config,modelConfigRules:null}},44]];
  for(const [name,value,expected] of cases){
    const home=mkdtempSync('/tmp/zcode-builtin-');
    const put=(file,data)=>{mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(data));};
    const active=api.desktopBuiltinPath(bundled,'4.0.0',{},home);
    const dev=api.desktopBuiltinPath(bundled,'0.0.0-dev',{},home);
    put(dev,{...release,revision:49});if(value!==null)put(active,value);
    const before=existsSync(active)?readFileSync(active,'utf8'):null;
    const auth=new api.ReadOnlyAuth(join(home,'credentials.json'));auth.read=()=>({apiKey:'SYNTHETIC_ONLY',generation:1});
    const runtime=api.createNativeServices(join(home,'service'),{auth,personalHome:home,paths:{
      executable:'/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper',
      script:'/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',builtin:bundled},
      discovery:()=>({installed:true,supported:true,sha256:'synthetic-auth-only',version:'0.18.0'})});
    try {
      const models=await runtime.services.models();assert.ok(models.models.length>0,name);
      const setup=await runtime.services.prepare(home,undefined,{threadId:'catalogue-'+name});
      const child=await setup.start(launch=>new api.NativeProcess(launch,1,null,()=>{},()=>{},20000));
      assert.equal(setup.launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,expected===48?active:bundled,name);
      try {
        await child.request('runtime/capabilities',{});
        const logs=setup.launch.env.ZCODE_LOG_DIR;
        const revisions=readdirSync(logs).filter(f=>f.endsWith('.jsonl')).flatMap(f=>readFileSync(join(logs,f),'utf8').split('\n').flatMap(line=>{try{return [JSON.parse(line).context?.configRevision].filter(v=>typeof v==='string');}catch{return [];}}));
        assert.ok(revisions.some(v=>v.includes(`zcode-builtin:${expected}:`)),name+': '+revisions);
      }finally{assert.equal(await child.close(),0);}
      const evidence=readFileSync(join(home,'service/service-evidence.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(evidence.filter(e=>e.event==='builtin-startup-cleanup').every(e=>e.remaining===0));
      assert.equal(existsSync(active)?readFileSync(active,'utf8'):null,before,'shared active remains unchanged');
      assert.equal(JSON.parse(readFileSync(dev,'utf8')).revision,49);
    }finally{await runtime.close();rmSync(home,{recursive:true});}
  }
});
