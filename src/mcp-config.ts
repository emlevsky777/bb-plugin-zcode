import { readFile, stat } from 'node:fs/promises';
import { dirname, basename, join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

type ObjectMap = Record<string, unknown>;
const object = (v: unknown): v is ObjectMap => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const strings = (v: unknown): boolean => object(v) && Object.values(v).every(x => typeof x === 'string');
const list = (v: unknown): boolean => Array.isArray(v) && v.every(x => typeof x === 'string');
export type McpDeclaration = { name: string; scope: 'user' | 'workspace'; [key: string]: unknown };
export type McpConfiguration = { servers: McpDeclaration[]; reason?: never } | { reason: string; servers?: never };
// Native file writers own these settings. Check their native shapes without
// resolving plugins or applying non-MCP values to a session.
const otherNativeSections = ['modelStream','permission','storage','network','features','memory','skills','skill','command','logging','toolConcurrency','modelAnomalyGuard','hooks'];
function nativeWrittenSettingsValid(file: ObjectMap): boolean {
  if (file.ui !== undefined && (!object(file.ui) ||
    file.ui.locale !== undefined && (typeof file.ui.locale !== 'string' || !['auto','en-US','zh-CN'].includes(file.ui.locale)) ||
    file.ui.theme !== undefined && (typeof file.ui.theme !== 'string' || !['auto','dark','light'].includes(file.ui.theme)))) return false;
  if (file.plugins === undefined) return true;
  const p = file.plugins;
  return object(p) && Object.keys(p).every(k => ['enabledPlugins','options','suppressedBuiltins'].includes(k)) &&
    (p.enabledPlugins === undefined || object(p.enabledPlugins) && Object.values(p.enabledPlugins).every(v => typeof v === 'boolean')) &&
    (p.options === undefined || object(p.options) && Object.values(p.options).every(v => object(v) && Object.values(v).every(x => typeof x === 'string' || typeof x === 'boolean' || typeof x === 'number' && Number.isFinite(x)))) &&
    (p.suppressedBuiltins === undefined || Array.isArray(p.suppressedBuiltins) && p.suppressedBuiltins.every(text));
}
export function normalizeMcpEntry(value: unknown): ObjectMap | null {
  if (!object(value)) return null;
  const v = { ...value };
  if (!('env' in v) && 'environment' in v) v.env = v.environment;
  delete v.environment;
  if (typeof v.enable === 'boolean' || typeof v.enabled === 'boolean') v.enabled = v.enable === false ? false : v.enabled ?? true;
  for (const k of ['enable','timeout','startup_timeout_sec']) delete v[k];
  if (v.type === 'remote') v.type = 'http';
  else if (typeof v.type !== 'string') {
    if (typeof v.command === 'string' && v.command.trim()) v.type = 'stdio';
    else if (typeof v.url === 'string' && v.url.trim()) v.type = 'http';
  }
  if (['http','sse'].includes(String(v.type)) && v.headers === undefined && v.http_headers !== undefined) v.headers = v.http_headers;
  delete v.http_headers;
  const common = ['type','enabled','alwaysLoad','isolation','protocolVersion','timeoutMs'];
  const allowed = v.type === 'stdio' ? [...common,'command','args','cwd','env'] : [...common,'url','headers','oauth'];
  if (!['stdio','http','sse'].includes(String(v.type)) || Object.keys(v).some(k => !allowed.includes(k))) return null;
  for (const k of ['enabled','alwaysLoad']) if (v[k] !== undefined && typeof v[k] !== 'boolean') return null;
  if (v.isolation !== undefined && !['session','workspace'].includes(String(v.isolation))) return null;
  if (v.protocolVersion !== undefined && !['auto','legacy','2026-07-28'].includes(String(v.protocolVersion))) return null;
  if (v.timeoutMs !== undefined && (typeof v.timeoutMs !== 'number' || !Number.isFinite(v.timeoutMs) || v.timeoutMs <= 0)) return null;
  if (v.type === 'stdio') {
    if (!text(v.command) || v.args !== undefined && !list(v.args) || v.cwd !== undefined && !text(v.cwd) || v.env !== undefined && !strings(v.env)) return null;
  } else {
    if (!text(v.url) || v.headers !== undefined && !strings(v.headers)) return null;
    if (v.oauth !== undefined) {
      const a = v.oauth;
      if (!object(a) || !['client_credentials','authorization_code'].includes(String(a.type))) return null;
      const fields = a.type === 'client_credentials' ? ['type','clientId','clientSecret','clientName','scope'] : ['type','clientId','clientSecret','clientName','redirectPath','scope'];
      if (Object.keys(a).some(k => !fields.includes(k)) || fields.slice(1).some(k => a[k] !== undefined && !text(a[k]) && !(k === 'scope' && a[k] === ''))) return null;
      if (a.type === 'client_credentials' && (!text(a.clientId) || !text(a.clientSecret))) return null;
    }
  }
  return v;
}
export async function nativeMcpPaths(cwd: string): Promise<string[]> {
  const dirs: string[] = []; let dir = resolve(cwd), found = false;
  for (;;) {
    dirs.push(dir);
    try { const marker = await stat(join(dir, '.git')); if (marker.isDirectory() || marker.isFile()) { found = true; break; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(dir); if (dir === parent) break; dir = parent;
  }
  return (found ? dirs.reverse() : [resolve(cwd)]).flatMap(d => [join(d,'zcode.json'),join(d,'.zcode','config.json')]);
}
export async function readNativeMcp(cwd: string, home = homedir()): Promise<McpConfiguration> {
  try {
    let project: Record<string, McpDeclaration> = {};
    let user: Record<string, McpDeclaration> = {};
    const files = [...(await nativeMcpPaths(cwd)).map(path => ({ path, scope: 'workspace' as const })), { path: join(home,'.zcode','cli','config.json'), scope: 'user' as const }];
    for (const { path, scope } of files) {
      let raw: string;
      try { raw = await readFile(path,'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; return { reason: 'A native configuration file cannot be read.' }; }
      let file: unknown;
      try { file = JSON.parse(raw); } catch { return { reason: 'A native configuration file is invalid JSON.' }; }
      if (!object(file)) return { reason: 'A native configuration file is not an object.' };
      if (file.$schema !== undefined && typeof file.$schema !== 'string' || otherNativeSections.some(k => file[k] !== undefined))
        return { reason: 'The native configuration contains settings outside the MCP reader’s verified coverage.' };
      if (!nativeWrittenSettingsValid(file))
        return { reason: 'The native UI/plugin configuration is invalid or outside the MCP reader’s verified coverage.' };
      if (file.mcp === undefined) continue;
      if (!object(file.mcp) || file.mcp.servers !== undefined && !object(file.mcp.servers)) return { reason: 'The native MCP section is invalid.' };
      const entries: Record<string, McpDeclaration> = {};
      for (const [name, rawEntry] of Object.entries(file.mcp.servers ?? {})) {
        const entry = normalizeMcpEntry(rawEntry);
        if (!entry || !name) return { reason: 'A native MCP declaration is invalid; native loading is retained for its valid neighbors.' };
        if (entry.enabled === false) {
          // Decide after effective precedence: an enabled user winner may
          // legitimately shadow a disabled project entry.
        }
        const { type, enabled, command, args, env, cwd: serverCwd, headers, ...rest } = entry;
        const options = { ...rest };
        // Native protocol requires positive integer timeout even though config accepts fractions.
        if (options.timeoutMs !== undefined && !Number.isInteger(options.timeoutMs)) return { reason: 'A native MCP timeout cannot be represented by the session protocol.' };
        const base = basename(dirname(path)) === '.zcode' ? dirname(dirname(path)) : dirname(path);
        entries[name] = type === 'stdio' ? { name, scope, ...options, command, args: args ?? [], env: Object.entries((env ?? {}) as Record<string,string>).map(([name,value]) => ({name,value})),
          ...(scope === 'workspace' ? { cwd: isAbsolute(String(serverCwd ?? '.')) ? serverCwd : resolve(base,String(serverCwd ?? '.')) } : serverCwd !== undefined ? {cwd:serverCwd} : {}), enabled } :
          { name, scope, ...options, type, headers: Object.entries((headers ?? {}) as Record<string,string>).map(([name,value]) => ({name,value})), enabled };
      }
      if (scope === 'user') user = entries;
      else project = entries; // Native mergeConfigs replaces each project MCP section.
    }
    const effective = Object.values({ ...project, ...user });
    if (effective.some(s => s.enabled === false)) return { reason: 'An effective native MCP server is disabled; the session protocol cannot preserve disabled declarations.' };
    return { servers: effective.map(({enabled, ...s}) => s as McpDeclaration) };
  } catch { return { reason: 'Native MCP discovery could not establish an exact configuration.' }; }
}
