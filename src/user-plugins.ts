import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, realpathSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { childEnvironment } from './process.ts';
import { record } from './errors.ts';
import { writeProjectConfigView } from './project-config-view.ts';
import { pluginStateStore } from './plugin-isolation.ts';
import { createPluginDiscoveryView } from './discovery-view.ts';
const run = promisify(execFile);
export const pluginsWarning = 'ZCode plugin discovery is unavailable or unsafe; user and project plugins are disabled. The regular thread remains available.';
export async function optionalUserPlugins(enabled: boolean, discover: () => Promise<UserPlugin[]>, warnings: string[]) {
  if (!enabled) return { enabled: false, plugins: [] as UserPlugin[] };
  try { return { enabled: true, plugins: await discover() }; }
  catch { warnings.push(pluginsWarning); return { enabled: false, plugins: [] as UserPlugin[] }; }
}
export type UserPlugin = { id: string; name: string; marketplace: string; version: string; rootPath: string;
  source: 'inline' | 'cache'; enabled: boolean; configuredOptions: Record<string, unknown>; declaredMcpServerNames: string[] };
export function userPluginMetadata(value: unknown): UserPlugin[] {
  if (!Array.isArray(value) || value.length > 1000) throw Error('Invalid plugin catalogue');
  const result: UserPlugin[] = [], seen = new Set<string>();
  for (const raw of value) {
    const p = record(raw);
    if (p.source === 'official' && p.marketplace === 'zcode-plugins-official') continue;
    if (!['inline', 'cache'].includes(String(p.source)) || typeof p.enabled !== 'boolean' ||
        !['id','name','marketplace','version','rootPath'].every(k => typeof p[k] === 'string' && String(p[k]).length > 0) ||
        p.id !== `${p.name}@${p.marketplace}` || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(String(p.name)) ||
        !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(String(p.marketplace)) ||
        !Array.isArray(p.declaredMcpServerNames) || p.declaredMcpServerNames.some(n => typeof n !== 'string' || !n || n.includes('\0')))
      throw Error('Invalid user plugin metadata');
    if (seen.has(String(p.id))) throw Error('Duplicate native plugin identity');
    seen.add(String(p.id));
    const options = record(p.configuredOptions ?? {});
    if (JSON.stringify(options).length > 65536 || Object.values(options).some(v =>
      !['string','number','boolean'].includes(typeof v) && !(Array.isArray(v) && v.every(x => typeof x === 'string'))))
      throw Error('Invalid plugin options');
    result.push({ id: String(p.id), name: String(p.name), marketplace: String(p.marketplace), version: String(p.version),
      rootPath: realpathSync(String(p.rootPath)), source: p.source as UserPlugin['source'], enabled: p.enabled,
      configuredOptions: options, declaredMcpServerNames: p.declaredMcpServerNames as string[] });
  }
  return result;
}
export async function readUserPlugins(cwd: string, paths: { executable: string; script: string; builtin: string }, userHome = homedir(), signal?: AbortSignal,
  observe?: (value: Record<string, unknown>) => void) {
  const view = createPluginDiscoveryView(userHome, cwd);
  try {
    const env = childEnvironment(process.env, { HOME: view.home, ELECTRON_RUN_AS_NODE: '1',
      ZCODE_STORAGE_DIR: view.data, ZCODE_DATA_BASE_DIR: view.data, ZCODE_SESSION_DB_PATH: join(view.home, '.zcode/cli/db/db.sqlite'),
      ZCODE_LOG_DIR: join(view.root, 'logs'), ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: paths.builtin, ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: paths.builtin });
    const { stdout } = await run(paths.executable, ['--require', view.preload, paths.script, '--json', 'plugins', 'list'],
      { cwd, env, signal, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
    const attempts = existsSync(view.attempts) ? readFileSync(view.attempts, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    if (attempts.length) throw Error('ZCode discovery attempted a write outside its snapshot or a network operation');
    return userPluginMetadata(JSON.parse(stdout)).map(p => ({ ...p, rootPath: view.aliases.get(p.rootPath) ?? p.rootPath }));
  } finally {
    try {
      const attempts = existsSync(view.attempts) ? readFileSync(view.attempts, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      observe?.({ event: 'plugin-discovery', isolatedHome: true, attempts });
    } finally { view.cleanup(); }
  }
}
export function applyUserPlugins(home: string, data: string, cwd: string, enabled: boolean, plugins: UserPlugin[] = [], subagentsEnabled?: boolean) {
  const selected = enabled ? plugins.filter(p => p.enabled) : [];
  const file = join(home, '.zcode/cli/config.json'), config = record(JSON.parse(readFileSync(file, 'utf8')));
  config.plugins = { dirs: selected.filter(p => p.source === 'inline').map(p => p.rootPath),
    enabledPlugins: Object.fromEntries(plugins.map(p => [p.id, enabled && p.enabled])),
    options: Object.fromEntries(selected.map(p => [p.id, p.configuredOptions])) };
  const servers: Record<string, unknown> = {};
  for (const p of plugins) for (const name of p.declaredMcpServerNames)
    servers[`plugin:${p.name}:${name}`] = { type: 'stdio', command: '/usr/bin/false', enabled: false };
  config.mcp = { servers };
  const records = selected.filter(p => p.source === 'cache').map(p => ({ id: p.id, name: p.name, marketplace: p.marketplace,
    version: p.version, installPath: p.rootPath, installedAt: new Date(0).toISOString(), scope: 'user' }));
  if (!existsSync(data)) mkdirSync(data, { recursive: true, mode: 0o700 });
  const store = pluginStateStore(home, data, enabled);
  writeFileSync(join(store, 'installed_plugins.json'), JSON.stringify({ version: 1, plugins: records }) + '\n', { encoding: 'utf8', mode: 0o600 });
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(config) + '\n', { encoding: 'utf8', mode: 0o600 }); renameSync(temp, file);
  return { preload: writeProjectConfigView(home, cwd, enabled, { storage: data, pluginStore: store }, subagentsEnabled),
    pluginStore: store, selected, disabledServerCount: Object.keys(servers).length };
}
