import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { api } from './helpers.mjs';
const mention=(text,name,source='skill',trigger='$',origin='project')=>({type:'text',text,mentions:[{start:text.indexOf(trigger+name),end:text.indexOf(trigger+name)+name.length+1,resource:{kind:'command',name,source,trigger,origin,label:name,argumentHint:null}}]});
test('M47 selected skills preserve Unicode/chunks and escape original Markdown paths; both menu triggers use Skill',async()=>{
  const root=mkdtempSync('/tmp/m47-mentions-');
  try {
    const path=join(root,'skill ] (dir)','SKILL.md');mkdirSync(join(root,'skill ] (dir)'));writeFileSync(path,'OWN');
    for(const trigger of ['$','/']){
      const item=mention('😀 \u0434\u043e '+trigger+'chosen \u043f\u043e\u0441\u043b\u0435','chosen','skill',trigger);
      const native={skills:[{name:'chosen',path,scope:'project',source:'zcode'}]};
      const resident={authority:'session',skills:[{name:'chosen',path,scope:'workspace',enabled:true}]};
      const target=api.resolveMentionTarget(api.selectedMentions([item])[0].mention,native,resident);
      const attachment={type:'localFile',path:'/tmp/file.txt'};
      const result=await api.convertMentions([item,{type:'text',text:'suffix'},attachment],async()=>target);
      assert.ok(result.input[0].text.startsWith('😀 \u0434\u043e [$chosen](<'));assert.ok(result.input[0].text.endsWith('>) \u043f\u043e\u0441\u043b\u0435'));
      assert.equal(result.input[1].text,'suffix');assert.equal(result.input[2],attachment);
      assert.match(result.input[3].text,/Skill tool.*"chosen"/);assert.equal(result.targets.length,1);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('M47 namespaced command moves selected inline token to native prefix, preserves args order and attachments',async()=>{
  const item=mention('before /team:command after','team:command','command','/');
  const attached={type:'localFile',path:'/tmp/file.txt'};
  const result=await api.convertMentions([item,{type:'text',text:'second'},attached],async()=>({source:'command',origin:'project',name:'team:command',path:'/tmp/command.md'}));
  assert.equal(result.input[0].text,'/team:command\nbefore  after');assert.equal(result.input[1].text,'second');assert.equal(result.input[2],attached);
  assert.deepEqual((await api.convertMentions([{type:'text',text:'plain $skill /command'}],async()=>{throw Error('must not lookup');})).input,[{type:'text',text:'plain $skill /command'}]);
});
test('M47 malformed, overlapping, duplicate, multi-command and builtin selections fail before lookup',async()=>{
  const item=mention('$skill','skill');
  for(const invalid of [{...item,text:'$other'},{...item,mentions:[{...item.mentions[0],start:-1}]},{...item,mentions:[item.mentions[0],item.mentions[0]]},
      mention('/compact','compact','command','/','builtin'),{type:'text',text:'/one /two',mentions:[...mention('/one /two','one','command','/').mentions,...mention('/one /two','two','command','/').mentions]}]){
    let calls=0;await assert.rejects(api.convertMentions([invalid],async()=>{calls++;}));assert.equal(calls,0);
  }
});
test('M47 identity lookup rejects missing/ambiguous source, stale session and unsupported command names',()=>{
  const root=mkdtempSync('/tmp/m47-identity-');
  try{
    const path=join(root,'command.md');writeFileSync(path,'OWN');
    const m=api.selectedMentions([mention('$same','same')])[0].mention;
    const row={name:'same',scope:'project',path,source:'zcode'},catalogue={skills:[row]};
    assert.throws(()=>api.resolveMentionTarget(m,{skills:[]}));
    assert.throws(()=>api.resolveMentionTarget(m,{skills:[row,row]}));
    assert.throws(()=>api.resolveMentionTarget(m,{skills:[{...row,scope:'user'}]}));
    assert.throws(()=>api.resolveMentionTarget(m,catalogue,{authority:'workspace',skills:[]}));
    assert.throws(()=>api.resolveMentionTarget(m,catalogue,{authority:'session',skills:[]}));
    const resident={authority:'session',skills:[{name:'same',scope:'workspace',path,enabled:true}]};
    assert.equal(api.resolveMentionTarget(m,catalogue,resident).path,realpathSync(path));
    const command=api.selectedMentions([mention('/one:two:command','one:two:command','command','/')])[0].mention;
    assert.throws(()=>api.resolveMentionTarget(command,{commands:[{...row,name:command.name}]}));
    const skillResult=api.resolveMentionTarget(m,{skills:[row],commands:[{...row,name:'same'}]},resident);
    assert.equal(skillResult.source,'skill');
  }finally{rmSync(root,{recursive:true,force:true});}
});
