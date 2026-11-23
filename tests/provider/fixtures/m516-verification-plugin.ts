// Stand-owned registered BB tool. No messages, network writes or owner config.
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
export default function verification(bb: BbPluginApi, providerId: string, evidencePath: string, workspace: string) {
  const log = (value: unknown) => appendFileSync(evidencePath,JSON.stringify(value)+'\n','utf8');
  bb.agents.registerTool({
    name:'inspect_bb_context',description:'Read the current BB thread, project and environment through the BB SDK. Return a fresh server nonce. Optional error or cancellable-delay verification.',
    parameters:{type:'object',properties:{nonce:{type:'string'},mode:{type:'string',enum:['inspect','error','delay','image']}},required:['nonce'],additionalProperties:false},
    presentation:{label:{pending:'Inspecting BB context',completed:'Inspected BB context'},icon:{glyph:'Info'}},
    async execute(value,ctx) {
      const params = value as {nonce:string;mode?:string};
      const call = {at:new Date().toISOString(),event:'executed',nonce:params.nonce,mode:params.mode??'inspect',threadId:ctx.threadId,projectId:ctx.projectId,serverNonce:randomUUID()};
      log(call);
      if (params.mode === 'error') return {content:[{type:'text' as const,text:'M516_EXPECTED_TOOL_ERROR '+params.nonce}],isError:true};
      if (params.mode === 'delay') await new Promise<void>((resolve,reject) => {
        const timer=setTimeout(()=>{ctx.signal.removeEventListener('abort',abort);resolve();},120000);
        const abort=()=>{clearTimeout(timer);log({...call,event:'cancelled',at:new Date().toISOString()});reject(Error('M516_DELAY_CANCELLED'));};
        if(ctx.signal.aborted)abort();else ctx.signal.addEventListener('abort',abort,{once:true});
      });
      const thread=await bb.sdk.threads.get({threadId:ctx.threadId});
      const project=await bb.sdk.projects.get({projectId:ctx.projectId});
      const environment=thread.environmentId?await bb.sdk.environments.get({environmentId:thread.environmentId}):null;
      const result={...call,threadId:thread.id,projectId:project.id,environmentId:environment?.id??null};
      log({...result,event:'result'});
      if (params.mode === 'image') return {content:[{type:'text' as const,text:JSON.stringify(result)},{type:'image' as const,mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII='},{type:'text' as const,text:'M516_IMAGE_AFTER'}]};
      return JSON.stringify(result);
    },
  });
  bb.agents.configure(context=>{
    if(context.environment.path===workspace) log({event:'configured',threadId:context.thread.id,providerId:context.provider.id,expectedProviderId:providerId});
    return {tools:context.environment.path===workspace?['inspect_bb_context']:[],skills:[]};
  });
}
