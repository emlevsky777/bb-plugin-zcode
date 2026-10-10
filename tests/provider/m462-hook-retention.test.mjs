import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from './helpers.mjs';
// P1: M462 native 15->14 observed rows + pinned transcript-hydration.ts:
// completed HookRun UI is absent cold, tool parts replay ahead of text parts.
function pair(){
 const row=(kind,entityId,extra={})=>({rowId:1,kind,entityId,turnId:'turn-on',createdAt:1,createdAtSeq:1,...extra});
 const header=row('turnHeader','input',{state:'completedSuccess',startedAt:1,endedAt:10,activeMs:9});
 const input=row('userInput','input',{text:'Read own fixture',origin:'realUser'});
 const hook=row('hookInvocation','hook',{hookInvocationId:'hook',hookEventName:'UserPromptSubmit',hookCount:1,state:'completed',startedAt:1,endedAt:2,durationMs:1,lane:'assistantWork',executions:[{hookRunId:'run',hookIndex:0,didExecute:true,state:'completed',outcome:'success',startedAt:1,endedAt:2,durationMs:1,displayName:'Own fixture',sourceKind:'plugin',pluginName:'m462-on'}]});
 const thought=row('reasoning','thought',{text:'Read fixture',state:'complete'}),text=row('assistantText','before',{text:'Reading',state:'complete'});
 const tool=row('toolCall','tool',{toolCallId:'call',assistantResponseId:'response',toolName:'Read',input:{path:'own'},output:{text:'M462_STANDALONE_OK'},status:'success',startedAt:3,endedAt:4});
 const endThought=row('reasoning','end-thought',{text:'Done',state:'complete'}),end=row('assistantText','after',{text:'M462_STANDALONE_OK',state:'complete'});
 const before=[header,input,hook,thought,text,tool,endThought,end].map((r,i)=>({...r,rowId:i+1}));
 const after=[header,input,tool,thought,text,endThought,end].map((r,i)=>({...r,rowId:i+1,createdAt:100,createdAtSeq:100+i,...r.kind==='toolCall'?{startedAt:30,endedAt:40}:{}}));
 const snapshot=window=>({logEpoch:'own',rows:{window,totalCount:window.length,firstRowId:1}});
 return {before:structuredClone(snapshot(before)),after:structuredClone(snapshot(after))};
}
test('M462 known completed hook cold hydration retains all message/tool payloads and explicitly reports omitted hook UI',()=>{
 const {before,after}=pair();assert.equal(api.retainedRows(before,after),true);
 assert.equal(api.retentionDifference(before,after).hookHydration.omittedSettledHookRows,1);
 const warnings=[];api.parseRow(before.rows.window[2],w=>warnings.push(w));assert.equal(warnings.length,0);
});
test('M462 OFF cold hydration also replays tool parts before text without losing payloads',()=>{
 const {before,after}=pair();before.rows.window.splice(2,1);before.rows.totalCount--;
 assert.equal(api.retainedRows(before,after),true);
 assert.equal(api.retentionDifference(before,after).hookHydration.omittedSettledHookRows,0);
 after.rows.window[2].output.text='Changed';assert.equal(api.retainedRows(before,after),false);
});
for(const mutation of ['text','tool-output','unknown-field','unknown-hook-field','unknown-execution-field','running-hook','unknown-kind','message-order','duplicate-entity','missing-row','partial-window'])
test('M462 hook hydration rejects '+mutation,()=>{
 const {before,after}=pair();
 if(mutation==='text')after.rows.window[4].text='Changed';
 if(mutation==='tool-output')after.rows.window[2].output.text='Changed';
 if(mutation==='unknown-field')after.rows.window[4].future=[2,1];
 if(mutation==='unknown-hook-field')before.rows.window[2].future=true;
 if(mutation==='unknown-execution-field')before.rows.window[2].executions[0].future=true;
 if(mutation==='running-hook')before.rows.window[2].state='running';
 if(mutation==='unknown-kind')before.rows.window[3].kind=after.rows.window[3].kind='future';
 if(mutation==='message-order')[after.rows.window[3],after.rows.window[4]]=[after.rows.window[4],after.rows.window[3]];
 if(mutation==='duplicate-entity')after.rows.window[6].entityId='before';
 if(mutation==='missing-row'){after.rows.window.pop();after.rows.totalCount--;}
 if(mutation==='partial-window')before.rows.totalCount++;
 assert.equal(api.retainedRows(before,after),false);
});
