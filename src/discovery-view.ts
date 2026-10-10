import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, realpathSync, readdirSync, symlinkSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { record } from './errors.ts';

// Native CLI0.16.9 list selects plugins, but may migrate config, seed cache and
// create data. No owner config/registry is symlinked into this writable view.
export function createPluginDiscoveryView(userHome: string, cwd = process.cwd()) {
  const root = mkdtempSync(join(tmpdir(), 'bb-zcode-plugin-discovery-'));
  try {
    const home = join(root, 'home'), data = join(root, 'data'), config = join(home, '.zcode/cli/config.json');
    mkdirSync(join(home, '.zcode/cli'), { recursive: true, mode: 0o700 });
    mkdirSync(join(data, 'cli/plugins'), { recursive: true, mode: 0o700 });
    const source = join(userHome, '.zcode/cli/config.json');
    const input = existsSync(source) ? record(JSON.parse(readFileSync(source, 'utf8'))) : {};
    if (input.plugins !== undefined && (!input.plugins || typeof input.plugins !== 'object' || Array.isArray(input.plugins))) throw Error('Invalid optional plugin settings');
    const plugins = input.plugins === undefined ? {} : record(input.plugins);
    if (Object.keys(plugins).some(k => !['enabled', 'dirs', 'enabledPlugins', 'options', 'extraKnownMarketplaces', 'suppressedBuiltins'].includes(k)))
      throw Error('Unknown optional plugin settings');
    writeFileSync(config, JSON.stringify({ plugins, storage: { dir: data }, hooks: { enabled: false },
      features: { mcp: false }, memory: { use: false } }) + '\n', { mode: 0o600 });
    const configuredStorage = record(input.storage ?? {}).dir;
    if (configuredStorage !== undefined && (typeof configuredStorage !== 'string' || !configuredStorage.trim())) throw Error('Invalid optional plugin storage');
    const storage = typeof configuredStorage === 'string' ? resolve(cwd, configuredStorage.startsWith('~/') ? join(userHome, configuredStorage.slice(2)) : configuredStorage) : join(userHome, '.zcode');
    const sourceStore = join(basename(storage) === 'cli' ? storage : join(storage, 'cli'), 'plugins'), registryFile = join(sourceStore, 'installed_plugins.json');
    const registry = existsSync(registryFile) ? record(JSON.parse(readFileSync(registryFile, 'utf8'))) : { version: 1, plugins: [] };
    if (registry.version !== 1 || !Array.isArray(registry.plugins) || Object.keys(registry).some(k => !['version','plugins'].includes(k)))
      throw Error('Invalid optional plugin registry');
    const aliases = new Map<string, string>();
    registry.plugins = registry.plugins.map(raw => {
      const p = record(raw);
      if (!['marketplace','name','version'].every(k => typeof p[k] === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(String(p[k]))))
        throw Error('Invalid optional installed plugin path');
      if (p.installPath !== undefined && (typeof p.installPath !== 'string' || !p.installPath.trim())) throw Error('Invalid optional installed plugin root');
      const original = realpathSync(typeof p.installPath === 'string' ? resolve(cwd, p.installPath) : join(sourceStore, 'cache', String(p.marketplace), String(p.name), String(p.version)));
      if (existsSync(join(dirname(original), `.${basename(original)}.transaction.json`))) throw Error('Pending cached plugin transaction; discovery is unsafe');
      const alias = join(data, 'cli/plugins/cache', String(p.marketplace), String(p.name), String(p.version));
      if (aliases.has(alias)) throw Error('Duplicate optional installed plugin root');
      mkdirSync(alias, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(original)) symlinkSync(join(original, name), join(alias, name));
      aliases.set(realpathSync(alias), original);
      return { ...p, installPath: alias };
    });
    writeFileSync(join(data, 'cli/plugins/installed_plugins.json'), JSON.stringify(registry) + '\n', { mode: 0o600 });
    const preload = join(root, 'discovery.cjs'), attempts = join(root, 'attempts.ndjson');
    writeFileSync(preload, discoveryFence(root, attempts), { mode: 0o600 });
    return { root, home, data, preload, attempts, aliases, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (e) { rmSync(root, { recursive: true, force: true }); throw e; }
}

export function discoveryFence(root: string, attempts: string) {
  return `'use strict';
const fs=require('node:fs'), path=require('node:path'), url=require('node:url');
const allowed=fs.realpathSync(${JSON.stringify(root)}), attempts=${JSON.stringify(attempts)};
const append=fs.appendFileSync, realpath=fs.realpathSync, exists=fs.existsSync;
function denied(kind, method) { append(attempts, JSON.stringify({kind,method})+'\\n'); throw Error('Read-only ZCode discovery rejected '+kind); }
function canonical(p) { p=path.resolve(p instanceof URL?url.fileURLToPath(p):String(p)); const tail=[]; while(!exists(p)){const parent=path.dirname(p);if(parent===p)break;tail.unshift(path.basename(p));p=parent;}return path.resolve(realpath(p),...tail); }
function writable(p, method) { if(typeof p==='number')return; const target=canonical(p); if(target!==allowed&&!target.startsWith(allowed+'/'))denied('owner-write',method); }
const mutations={writeFile:[0],appendFile:[0],mkdir:[0],rmdir:[0],rm:[0],unlink:[0],rename:[0,1],chmod:[0],chown:[0],lchmod:[0],lchown:[0],truncate:[0],utimes:[0],lutimes:[0],mkdtemp:[0],copyFile:[1],cp:[1],link:[0,1],symlink:[0,1],createWriteStream:[0]};
for(const api of new Set([fs,fs.promises,require('node:fs/promises')])) {
 for(const [name,indexes] of Object.entries(mutations))for(const method of [name,name+'Sync'])if(typeof api[method]==='function'){const original=api[method];api[method]=function(...args){for(const i of indexes)writable(args[i],method);return original.apply(this,args);};}
 for(const method of ['open','openSync'])if(typeof api[method]==='function'){const original=api[method];api[method]=function(file,flags,...args){const writes=typeof flags==='number'?(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND))!==0:typeof flags==='string'&&/[wa+]/.test(flags);if(writes)writable(file,method);return original.call(this,file,flags,...args);};}
}
// Project selection remains native. Only the plugin section enters discovery;
// no project storage/network paths, MCP or hooks are used by this CLI listing.
const read=fs.readFileSync, cwd=process.cwd(), candidates=new Set();
for(let dir=cwd;;){candidates.add(path.join(dir,'zcode.json'));candidates.add(path.join(dir,'.zcode/config.json'));const parent=path.dirname(dir);if(parent===dir)break;dir=parent;}
const known=new Set([...candidates].filter(exists).map(p=>realpath(p)));
fs.readFileSync=function(file,...args){const bytes=read.call(this,file,...args);const p=typeof file==='string'?path.resolve(file):file instanceof URL?url.fileURLToPath(file):null;if(!p||!(candidates.has(p)||known.has(canonical(p))))return bytes;const config=JSON.parse(Buffer.isBuffer(bytes)?new TextDecoder('utf8',{fatal:true}).decode(bytes):bytes);if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Invalid project plugin config');const output=JSON.stringify({plugins:config.plugins??{}});return Buffer.isBuffer(bytes)?Buffer.from(output):output;};
for(const name of ['node:http','node:https','node:http2','node:tls','node:net','node:dgram','node:dns','node:dns/promises']) {
 const api=require(name);for(const method of ['request','get','connect','createConnection','createSocket','lookup','resolve','resolve4','resolve6','resolveAny','reverse','lookupService'])if(typeof api[method]==='function')api[method]=()=>denied('network-attempt',name+'.'+method);
 for(const type of ['Socket','Resolver'])if(api[type]?.prototype)for(const method of ['connect','send','lookup','resolve','resolve4','resolve6','resolveAny','reverse'])if(typeof api[type].prototype[method]==='function')api[type].prototype[method]=()=>denied('network-attempt',name+'.'+type+'.'+method);
}
global.fetch=()=>denied('network-attempt','fetch');
for(const name of ['WebSocket','EventSource'])if(global[name])global[name]=class{constructor(){denied('network-attempt',name);}};
const child=require('node:child_process');for(const method of ['spawn','exec','execFile','fork','spawnSync','execSync','execFileSync'])child[method]=()=>denied('subprocess',method);
process.dlopen=()=>denied('native-addon','dlopen');
require('node:module').syncBuiltinESMExports();
`;
}
