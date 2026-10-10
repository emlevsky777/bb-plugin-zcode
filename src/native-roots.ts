import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { experimental_filterResolvedNativeRoots } from '@get-bb/plugin-sdk/host';
import { preparePersonalSettings } from './personal-settings.ts';
import { nativePaths } from './runtime.ts';
import { childEnvironment } from './process.ts';
import { record } from './errors.ts';
import { readUserPlugins, applyUserPlugins, pluginsWarning } from './user-plugins.ts';
import { projectConfigPaths } from './project-config-view.ts';

const run = promisify(execFile);
type ProviderResolvedNativeRootInput = { path: string; origin: 'user' | 'project'; shape: 'skill-file' | 'command-file'; fallbackName?: string; namePrefix?: string; ancestors: boolean; recursive: boolean };
// The native CLI selects precedence, disabled entries and names. Only canonical
// original standalone files enter bb; optional user/plugin roots follow the
// same native catalogue when their explicit switch is on.
export function catalogueRoots(value: unknown, side: 'skills' | 'commands', pluginsEnabled = false) {
  const rows = record(value)[side];
  if (!Array.isArray(rows)) throw Error('Native root catalogue unavailable');
  const seen = new Set<string>(), roots: ProviderResolvedNativeRootInput[] = [];
  for (const raw of rows) {
    const row = record(raw);
    if (!['user', 'project'].includes(String(row.scope))) continue;
    // Installed commands list has source:plugin but no pluginName; its name
    // is already the native selected basename, unlike skill metadata.
    const plugin = pluginsEnabled && row.source === 'plugin';
    if (!plugin && (row.pluginName !== undefined || !['zcode', 'agents', 'configured'].includes(String(row.source)))) continue;
    if (typeof row.path !== 'string' || typeof row.name !== 'string') continue;
    try {
      const path = realpathSync(row.path);
      const names = row.name.split(':');
      // SDK0.6.15 allows one plugin-like namespace and derives a command's
      // basename itself. Never publish a different name from the native CLI.
      if (side === 'commands' && (names.length > 2 || names.at(-1) !== basename(path).replace(/\.md$/i, '').toLowerCase())) {
        process.stderr.write('ZCode optional command name cannot be represented by bb\n'); continue;
      }
      if (seen.has(path)) continue;
      seen.add(path);
      roots.push({ path, origin: row.scope as 'user' | 'project', shape: side === 'skills' ? 'skill-file' : 'command-file',
        ...(side === 'skills' ? { fallbackName: row.name } : names.length === 2 ? { namePrefix: names[0] + ':' } : {}), ancestors: false, recursive: false });
    } catch { /* Only an unavailable optional entry is omitted. */ }
  }
  return roots;
}
export async function resolveNativeRoots(cwd: string | null, scratch: string, signal?: AbortSignal, userHome = homedir(), pluginsEnabled = false, pluginPaths: string[] = [], paths = nativePaths()) {
  if (!cwd) return { skills: [], commands: [] };
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  // Generated plugin commands need durable paths; only owned host storage is
  // used, never a root removed at the end of this listing.
  const root = join(scratch, 'catalogue-' + createHash('sha256').update(cwd + '\n' + userHome).digest('hex')), home = join(root, 'home'), data = join(root, 'data');
  {
    preparePersonalSettings(home, data, cwd, userHome);
    let enabled = pluginsEnabled, plugins: Awaited<ReturnType<typeof readUserPlugins>> = [];
    if (enabled) try { plugins = await readUserPlugins(cwd, paths, userHome, signal); }
    catch { enabled = false; process.stderr.write(pluginsWarning + '\n'); }
    const plan = applyUserPlugins(home, data, cwd, enabled, plugins);
    pluginPaths.push(...plan.selected.map(p => p.rootPath));
    const env = childEnvironment(process.env, { HOME: home, ELECTRON_RUN_AS_NODE: '1', ZCODE_DATA_BASE_DIR: data,
      ZCODE_STORAGE_DIR: data, ZCODE_SESSION_DB_PATH: join(home, '.zcode/cli/db/db.sqlite'), ZCODE_LOG_DIR: join(root, 'logs'),
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: paths.builtin, ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: paths.builtin });
    const answer: { skills: ProviderResolvedNativeRootInput[]; commands: ProviderResolvedNativeRootInput[] } = { skills: [], commands: [] };
    for (const side of ['skills', 'commands'] as const) {
      try {
        const { stdout } = await run(paths.executable, ['--require', plan.preload, paths.script, '--json', side, 'list'],
          { cwd, env, signal, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
        answer[side] = catalogueRoots(JSON.parse(stdout), side, enabled);
      } catch { process.stderr.write(`ZCode optional ${side} catalogue unavailable\n`); }
    }
    return experimental_filterResolvedNativeRoots(answer, { warn: () => process.stderr.write('ZCode optional native root omitted\n') }).answer;
  }
}

// Cheap change fingerprint over the same user/project inputs the CLI
// reads. Recursive name/size/mtime listing, no content reads. Covers
// add/remove/rename; a same-tick same-size rewrite may wait for the next
// change or a manual refresh (documented limit, never silent wrong data:
// staleness only delays new entries, never invents them).
export function rootsFingerprint(cwd: string, userHome = homedir(), pluginPaths: string[] = []) {
  const rows: string[] = [];
  let warned = false;
  const warn = () => { if (!warned) process.stderr.write('ZCode optional root fingerprint omitted a cycle or exceeded its traversal limit\n'); warned = true; };
  const walk = (dir: string, tag: string) => {
    const seen = new Set<string>(); let count = 0;
    const visit = (path: string, depth = 0) => {
      if (++count > 10000 || depth > 32) { warn(); rows.push(tag + ':bounded:' + relative(dir, path)); return; }
      let st;
      try { st = statSync(path); } catch (e) { rows.push(tag + ':unavailable:' + relative(dir, path)); return; }
      if (st.isDirectory()) {
        let canonical: string;
        try { canonical = realpathSync(path); } catch { rows.push(tag + ':unavailable:' + relative(dir,path)); return; }
        if (seen.has(canonical)) { warn(); rows.push(tag + ':alias:' + relative(dir,path)); return; } seen.add(canonical);
        let names: string[];
        try { names = readdirSync(path); } catch { rows.push(tag + ':unreadable:' + relative(dir, path)); return; }
        for (const name of names.sort()) { if (count >= 10000) { warn(); rows.push(tag + ':bounded'); break; } visit(join(path, name), depth + 1); }
      } else {
        rows.push(tag + ':' + relative(dir, path) + ':' + st.size + ':' + Number(st.mtimeMs));
      }
    };
    let missing = false;
    try { if (!statSync(dir).isDirectory()) missing = true; } catch { missing = true; }
    if (missing) { rows.push(tag + ':missing'); return; }
    visit(dir);
  };
  walk(join(userHome, '.zcode/skills'), 'user-zcode-skills');
  walk(join(userHome, '.agents/skills'), 'user-agents-skills');
  walk(join(userHome, '.zcode/commands'), 'user-zcode-commands');
  walk(join(userHome, '.agents/commands'), 'user-agents-commands');
  walk(join(cwd, '.zcode/skills'), 'project-zcode-skills');
  walk(join(cwd, '.zcode/commands'), 'project-zcode-commands');
  walk(join(cwd, '.agents/skills'), 'project-agents-skills');
  walk(join(cwd, '.agents/commands'), 'project-agents-commands');
  for (const file of [...projectConfigPaths(cwd), join(userHome,'.zcode/cli/plugins/installed_plugins.json')]) {
    try { const st = statSync(file); rows.push('config:' + file + ':' + st.size + ':' + Number(st.mtimeMs)); }
    catch { rows.push('config:' + file + ':missing'); }
  }
  for (const dir of [...new Set(pluginPaths)].sort()) walk(dir, 'plugin:' + dir);
  try {
    const st = statSync(join(userHome, '.zcode/cli/config.json'));
    rows.push('personal-config:' + st.size + ':' + Number(st.mtimeMs));
  } catch { rows.push('personal-config:missing'); }
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

// In-memory menu per project folder of this host worker. Isolation holds:
// the cache stores only root paths/names (no history, sessions, or
// instructions); a personal-layer read failure still disables only that layer
// because the fingerprint changes and the CLI path re-derives degradation.
const rootsCache = new Map<string, { fingerprint: string; pluginPaths: string[]; answer: { skills: ProviderResolvedNativeRootInput[]; commands: ProviderResolvedNativeRootInput[] } }>();
export function clearRootsCache() { rootsCache.clear(); }
export function rootsCacheSize() { return rootsCache.size; }
export async function resolveNativeRootsCached(cwd: string | null, scratch: string, signal?: AbortSignal, userHome = homedir(), pluginsEnabled = false, paths = nativePaths()) {
  if (!cwd) return { skills: [], commands: [] };
  const key = cwd + '\n' + userHome + '\n' + pluginsEnabled;
  const hit = rootsCache.get(key);
  const fingerprint = rootsFingerprint(cwd, userHome, hit?.pluginPaths ?? []);
  if (hit && hit.fingerprint === fingerprint) return structuredClone(hit.answer);
  const pluginPaths: string[] = [];
  const answer = await resolveNativeRoots(cwd, scratch, signal, userHome, pluginsEnabled, pluginPaths, paths);
  rootsCache.set(key, { fingerprint: rootsFingerprint(cwd,userHome,pluginPaths), pluginPaths, answer: structuredClone(answer) });
  return answer;
}
