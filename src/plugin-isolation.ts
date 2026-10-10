import { mkdirSync, lstatSync, realpathSync, readlinkSync, symlinkSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { record } from './errors.ts';

// Only owned mutable state is split. storage.dir and official cache remain
// shared; session DB/HOME remain bound to the canonical bb thread identity.
export function ownedDirectory(root: string, path: string) {
  root = resolve(root); path = resolve(path);
  if (path !== root && !path.startsWith(root + '/')) throw Error('Plugin state escaped owned storage');
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw Error('Owned storage is aliased');
  let current = root;
  for (const name of relative(root, path).split('/').filter(Boolean)) {
    current = join(current, name);
    try { if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw Error('Owned plugin directory conflict'); }
    catch (e) {
      if (record(e).code !== 'ENOENT') throw e;
      try { mkdirSync(current, { mode: 0o700 }); } catch (race) { if (record(race).code !== 'EEXIST') throw race; }
      const st = lstatSync(current);
      if (!st.isDirectory() || st.isSymbolicLink()) throw Error('Owned plugin directory conflict');
    }
  }
  return path;
}
export function pluginStateStore(home: string, storage: string, enabled: boolean) {
  const root = ownedDirectory(storage, join(storage, 'cli/plugin-states',
    createHash('sha256').update(realpathSync(home)).digest('hex'), enabled ? 'on' : 'off'));
  const cache = ownedDirectory(storage, join(storage, 'cli/plugins/cache')), link = join(root, 'cache');
  try {
    if (!lstatSync(link).isSymbolicLink() || readlinkSync(link) !== cache || realpathSync(link) !== realpathSync(cache))
      throw Error('Shared official plugin cache conflict');
  } catch (e) { if (record(e).code !== 'ENOENT') throw e; symlinkSync(cache, link, 'dir'); }
  return root;
}
export function assertEmptyWorkspaceTrust(home: string, storage: string) {
  const config = record(JSON.parse(readFileSync(join(home, '.zcode/cli/config.json'), 'utf8')));
  if (record(config.storage).dir !== storage) throw Error('Workspace hook trust storage is unconfirmed; thread stopped before input');
  const security = ownedDirectory(storage, join(storage, 'security')), file = join(security, 'workspace-hook-trust-v1.json');
  let st;
  try { st = lstatSync(file); } catch (error) {
    if (record(error).code === 'ENOENT') return { file, records: 0, present: false };
    throw error;
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) throw Error('Workspace hook trust store is unsafe; thread stopped before input');
  const trust = record(JSON.parse(readFileSync(file, 'utf8')));
  if (trust.schemaVersion !== 1 || !Array.isArray(trust.records) || trust.records.length !== 0 ||
      Object.keys(trust).some(k => !['schemaVersion', 'records'].includes(k)))
    throw Error('Workspace hook trust grants or unknown state found; thread stopped before input');
  return { file, records: 0, present: true };
}
export function assertOffPluginCatalogue(value: unknown) {
  const catalogue = record(value);
  if (catalogue.authority !== 'session' || !Array.isArray(catalogue.plugins))
    throw Error('ZCode OFF plugin state is unavailable; thread stopped before input');
  const seen = new Set<string>();
  for (const raw of catalogue.plugins) {
    const p = record(raw);
    if (typeof p.pluginId !== 'string' || typeof p.name !== 'string' || typeof p.marketplace !== 'string' ||
        p.pluginId !== `${p.name}@${p.marketplace}` || typeof p.enabled !== 'boolean' || seen.has(p.pluginId))
      throw Error('ZCode OFF plugin state is unknown; thread stopped before input');
    seen.add(p.pluginId);
    if (p.enabled && p.marketplace !== 'zcode-plugins-official')
      throw Error('ZCode loaded a non-official plugin while OFF; thread stopped before input');
  }
  return catalogue;
}
export function assertOfficialLaunchIsolation(pluginStore: string, preload: string, catalogue?: unknown) {
  const root = join(pluginStore, 'runtime-manifests');
  let servers = 0;
  let names: string[];
  try { names = readdirSync(root); } catch (error) {
    const c = record(catalogue ?? {});
    // Copy-on-read creates this directory even for a manifest without MCP.
    // Only a positively empty session catalogue can justify its absence.
    if (record(error).code === 'ENOENT' && (c.authority !== 'session' || !Array.isArray(c.plugins) || c.plugins.length !== 0))
      throw Error('Official plugin launch isolation is unavailable (ENOENT); thread stopped before input to protect thread data.');
    if (record(error).code !== 'ENOENT') throw error;
    names = [];
  }
  for (const name of names) for (const version of readdirSync(join(root, name))) {
    const file = join(root, name, version, '.zcode-plugin/plugin.json'), st = lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) throw Error('Official plugin launch isolation is unsafe; thread stopped before input');
    const manifest = record(JSON.parse(readFileSync(file, 'utf8')));
    if (manifest.mcpServers === undefined) continue;
    if (manifest.mcpServers === null || typeof manifest.mcpServers !== 'object' || Array.isArray(manifest.mcpServers))
      throw Error('Official plugin launch manifest is unknown; thread stopped before input');
    for (const raw of Object.values(record(manifest.mcpServers))) {
      const server = record(raw), args = server.args;
      if (!Array.isArray(args) || args.some(a => typeof a !== 'string') ||
          args.filter(a => a === '--require').length !== 1 || args[args.indexOf('--require') + 1] !== preload)
        throw Error('Official plugin launch arguments disagree with thread isolation; thread stopped before input');
      servers++;
    }
  }
  return { isolatedLaunchServers: servers, ...(servers === 0 ? { warning: 'No official MCP launches found' } : {}) };
}
