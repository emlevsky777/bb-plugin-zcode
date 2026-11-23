import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { decodeBridgeJsonRpcResponse, decodeToolCallResponsePayload } from '@get-bb/plugin-sdk/provider-bridge';
import type { DynamicTool } from '@get-bb/plugin-sdk/provider-bridge';
import { record } from './errors.ts';

type Result = ReturnType<typeof decodeToolCallResponsePayload>;
type Pending = { resolve: (result: Result) => void; rpcId: string; nativeId: string | number };
const failed = (text: string): Result => decodeToolCallResponsePayload({success:false,contentItems:[{type:'inputText',text}]});
export class BbToolEndpoint {
  readonly name: string;
  readonly tools: ReadonlyMap<string, DynamicTool>;
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private readonly server;
  private closePromise: Promise<void> | undefined;
  private readonly send: (value: unknown) => void;
  private readonly identity: () => { threadId: string; providerThreadId: string; turnId: string | null };
  url = '';
  constructor(tools: readonly DynamicTool[], send: (value: unknown) => void,
    identity: () => { threadId: string; providerThreadId: string; turnId: string | null }, reservedNames: readonly string[] = []) {
    const names = new Set(reservedNames);
    let name = 'bb_tools', suffix = 1;
    while (names.has(name)) name = 'bb_tools_' + suffix++;
    this.name = name;
    this.send = send; this.identity = identity;
    this.tools = new Map(tools.map(t => [t.name, structuredClone(t)]));
    this.server = createServer((req,res) => {
      void (async () => {
        if (this.closed) { res.writeHead(503).end(); return; }
        if (req.headers.origin !== undefined) { res.writeHead(403).end(); return; }
        if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
        if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
        if (req.method !== 'POST') { res.writeHead(405, {Allow:'POST, DELETE'}).end(); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        let message: Record<string,unknown>;
        try { message = record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { res.writeHead(400).end(); return; }
        const {id,method} = message;
        if (message.jsonrpc !== '2.0' || typeof method !== 'string') { res.writeHead(400).end(); return; }
        if (id === undefined) {
          if (method === 'notifications/cancelled') this.cancelNative(record(message.params).requestId);
          res.writeHead(202).end(); return;
        }
        if (typeof id !== 'string' && typeof id !== 'number') { res.writeHead(400).end(); return; }
        let reply: unknown;
        if (method === 'initialize') reply = { protocolVersion: record(message.params).protocolVersion ?? '2024-11-05',
          capabilities:{tools:{}},serverInfo:{name:'bb-plugin-tools',version:'1.0.0'} };
        else if (method === 'ping') reply = {};
        else if (method === 'tools/list') reply = {tools:[...this.tools.values()].map(t => ({name:t.name,description:t.description,inputSchema:t.inputSchema}))};
        else if (method === 'tools/call') {
          const params = record(message.params);
          const abort = () => this.cancelNative(id);
          res.on('close', abort);
          try {
            const result = await this.call(String(params.name), params.arguments, id);
            reply = { content: result.contentBlocks, isError: result.isError };
          } finally { res.off('close',abort); }
        } else {
          res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}})); return;
        }
        if (!res.destroyed) res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id,result:reply}));
      })().catch(() => { if (!res.destroyed) res.writeHead(500).end(); });
    });
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve,reject) => {
      const error = (e: Error) => reject(e);
      this.server.once('error',error);
      this.server.listen(0,'127.0.0.1',() => {this.server.off('error',error);resolve();});
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw Error('BB tool endpoint address unavailable');
    this.url = `http://127.0.0.1:${address.port}/mcp`;
  }
  declaration() { return {name:this.name,scope:'user' as const,type:'http',url:this.url,headers:[],alwaysLoad:true}; }
  private call(name: string, args: unknown, nativeId: string | number): Promise<Result> {
    if (this.closed) return Promise.resolve(failed('BB tool attachment was closed.'));
    if (!this.tools.has(name)) return Promise.resolve(failed('Unknown BB tool.'));
    if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) return Promise.resolve(failed('Tool arguments must be an object.'));
    const identity = this.identity();
    if (!identity.providerThreadId) return Promise.resolve(failed('Native session identity is not ready.'));
    const rpcId = 'zcode-tool:' + randomUUID();
    return new Promise(resolve => {
      this.pending.set(rpcId,{resolve,rpcId,nativeId});
      try { this.send({jsonrpc:'2.0',id:rpcId,method:'item/tool/call',params:{...identity,callId:rpcId,tool:name,arguments:args ?? {}}}); }
      catch { this.pending.delete(rpcId);resolve(failed('BB tool dispatch failed.')); }
    });
  }
  handleResponse(message: unknown): boolean {
    const response = decodeBridgeJsonRpcResponse(message);
    if (!response || typeof response.id !== 'string') return false;
    const pending = this.pending.get(response.id);
    if (!pending) return false;
    this.pending.delete(response.id);
    pending.resolve('error' in response ? failed(response.error.message ?? 'BB tool call failed.') : decodeToolCallResponsePayload(response.result));
    return true;
  }
  private cancelNative(nativeId: unknown): void {
    for (const [id,p] of this.pending) if (p.nativeId === nativeId) this.cancel(id,p);
  }
  private cancel(id: string, pending: Pending): void {
    this.pending.delete(id);
    try { this.send({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id}}); } catch { /* Transport gone; no retry. */ }
    finally { pending.resolve(failed('BB tool call cancelled.')); }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const [id,p] of this.pending) this.cancel(id,p);
    this.closePromise = new Promise(resolve => {
      this.server.close(() => resolve());
      // Responses are settled above; close idle and interrupted native sockets too.
      this.server.closeAllConnections();
    });
    return this.closePromise;
  }
  get pendingCount() { return this.pending.size; }
}
