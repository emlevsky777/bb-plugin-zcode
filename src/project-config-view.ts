import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Installed CLI0.16.9 reads these project layers synchronously. Keep original
// paths and all unrelated fields; no bundle or source config is rewritten.
export function projectConfigPaths(cwd: string) {
  const paths: string[] = [];
  for (let dir = resolve(cwd);;) {
    paths.push(join(dir, 'zcode.json'), join(dir, '.zcode/config.json'));
    const parent = dirname(dir); if (parent === dir) break; dir = parent;
  }
  return paths;
}
export function writeProjectConfigView(home: string, cwd: string, enabled: boolean,
  isolation?: { storage: string; pluginStore: string }, subagentsEnabled?: boolean) {
  const dir = join(home, '.bb-zcode'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'project-view.cjs');
  const source = `'use strict';
const fs = require('node:fs'), path = require('node:path');
${isolation ? `const join = path.join;
const sharedPluginRoot = ${JSON.stringify(join(isolation.storage, 'cli/plugins'))};
const ownPluginRoot = ${JSON.stringify(isolation.pluginStore)};
path.join = function(...parts) { const result = join.apply(this, parts); return result === sharedPluginRoot ? ownPluginRoot : result; };
// EEn writes official MCP launch args (including process.execArgv). Keep these
// generated manifests and their atomic temp files private, sharing assets only.
const baseRead = fs.readFileSync, baseWrite = fs.writeFileSync, baseRename = fs.renameSync, baseRm = fs.rmSync;
const cacheRoots = [...new Set([join(ownPluginRoot,'cache'), join(sharedPluginRoot,'cache'), fs.realpathSync(join(sharedPluginRoot,'cache'))])];
function manifestView(file) {
  if (typeof file !== 'string') return file;
  const p = path.resolve(file);
  for (const cache of cacheRoots) {
    const prefix = cache+'/zcode-plugins-official/'; if (!p.startsWith(prefix)) continue;
    const parts=p.slice(prefix.length).split('/');
    if(parts.length!==4||parts[2]!=='.zcode-plugin'||!parts.slice(0,2).every(v=>/^[a-z0-9][a-z0-9._-]*$/i.test(v))||/\\.(tmp-|backup|seed-lock)/.test(parts[1])) continue;
    const dir=join(ownPluginRoot,'runtime-manifests',parts[0],parts[1],'.zcode-plugin');fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const result=join(dir,parts[3]);
    if(parts[3]==='plugin.json'&&!fs.existsSync(result)&&fs.existsSync(p))baseWrite(result,baseRead(p),{mode:0o600});
    return result;
  }
  return file;
}
fs.readFileSync=function(file,...args){return baseRead.call(this,manifestView(file),...args);};
fs.writeFileSync=function(file,...args){return baseWrite.call(this,manifestView(file),...args);};
fs.renameSync=function(from,to){return baseRename.call(this,manifestView(from),manifestView(to));};
fs.rmSync=function(file,...args){return baseRm.call(this,manifestView(file),...args);};
require('node:module').syncBuiltinESMExports();` : ''}
const candidates = new Set(${JSON.stringify(projectConfigPaths(cwd))});
const canonical = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const known = new Set([...candidates].map(canonical));
const read = fs.readFileSync;
fs.readFileSync = function(file, options) {
  const bytes = read.apply(this, arguments);
  const p = typeof file === 'string' ? file : file instanceof URL && file.protocol === 'file:' ? require('node:url').fileURLToPath(file) : null;
  if (!p || !(candidates.has(path.resolve(p)) || known.has(canonical(p)))) return bytes;
  let config;
  try {
    const text = Buffer.isBuffer(bytes) ? new TextDecoder('utf-8', {fatal:true}).decode(bytes) : bytes;
    config = JSON.parse(text);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('Invalid project config');
  } catch { throw Error('ZCode project config isolation is unavailable; thread stopped before input to protect plugin and hook settings.'); }
  delete config.mcp;
  ${subagentsEnabled === undefined ? '' : `config.features = { ...config.features, subagent: ${subagentsEnabled} };`}
  ${enabled ? '' : 'delete config.plugins; delete config.hooks;'}
  const output = JSON.stringify(config);
  return Buffer.isBuffer(bytes) ? Buffer.from(output, 'utf8') : output;
};
`;
  writeFileSync(file, source, { encoding: 'utf8', mode: 0o600 });
  return file;
}
