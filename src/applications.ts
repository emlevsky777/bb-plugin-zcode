import { execFileSync } from 'node:child_process';
import { readdirSync, realpathSync, existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export function pathsForZCode(bundle: string) {
  return { executable: join(bundle, 'Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper'),
    script: join(bundle, 'Contents/Resources/glm/zcode.cjs'), builtin: join(bundle, 'Contents/Resources/config/provider/zcode-builtin.json') };
}
export function bbBundle(execPath = process.execPath): string | null {
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return match?.[1] ?? null;
}
export function findZCode(options: { home?: string; applicationDirs?: string[]; spotlight?: () => string[];
  bundleId?: (path: string) => string; canonical?: (path: string) => string; enumerate?: (dir: string) => string[] } = {}) {
  const dirs = options.applicationDirs ?? ['/Applications', join(options.home ?? homedir(), 'Applications')];
  const id = options.bundleId ?? (path => execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(path, 'Contents/Info.plist')], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  const canonical = options.canonical ?? realpathSync;
  const candidates = new Map<string, 'mdfind' | 'applications'>();
  const add = (path: string, method: 'mdfind' | 'applications') => {
    try {
      if (!isAbsolute(path) || !path.endsWith('.app') || id(path) !== 'dev.zcode.app') return;
      const actual = canonical(path);
      if (!candidates.has(actual)) candidates.set(actual, method);
    } catch { /* Stale Spotlight record or unrelated/unreadable bundle. */ }
  };
  try { for (const path of (options.spotlight ?? (() => execFileSync('/usr/bin/mdfind', ['kMDItemCFBundleIdentifier == "dev.zcode.app"'], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)))()) add(path, 'mdfind'); } catch { /* Spotlight unavailable: enumerate both installation directories. */ }
  if (!candidates.size) for (const dir of dirs) try { for (const name of (options.enumerate ?? readdirSync)(dir).filter(name => name.endsWith('.app'))) add(join(dir, name), 'applications'); } catch { /* A missing installation directory is normal. */ }
  const rankedDirs = dirs.map(dir => { try { return canonical(dir); } catch { return resolve(dir); } });
  const rank = (path: string) => { const i = rankedDirs.findIndex(dir => dirname(path) === dir); return i < 0 ? dirs.length : i; };
  const bundles = [...candidates.keys()].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const bundle = bundles[0] ?? null;
  return { bundle, method: bundle ? candidates.get(bundle)! : null, candidates: bundles,
    message: bundle ? `ZCode: ${bundle} (found via ${candidates.get(bundle)}).${bundles.length > 1 ? ` Selected deterministically from: ${bundles.join(', ')}; system Applications, user Applications, then lexical path order.` : ''}`
      : `ZCode Desktop was not found. Searched Spotlight for bundle ID dev.zcode.app and ${dirs.join(', ')}. Install ZCode Desktop and retry.` };
}
export function createZCodeLocator(root: string, options: Parameters<typeof findZCode>[0] = {},
  observe: (value: Record<string, unknown>) => void = () => {}) {
  const file = join(root, 'application-path.json');
  let current: ReturnType<typeof findZCode> | undefined;
  const valid = (bundle: unknown): bundle is string => typeof bundle === 'string' && isAbsolute(bundle) && bundle.endsWith('.app') && Object.values(pathsForZCode(bundle)).every(existsSync);
  return (force = false) => {
    if (!force && current && valid(current.bundle)) return current;
    if (!force) try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.version === 1 && valid(saved.bundle)) {
        current = { bundle: saved.bundle, method: null, candidates: [saved.bundle], message: `ZCode: ${saved.bundle}.` };
        observe({ event: 'zcode-path-cache-hit', bundle: saved.bundle, search: false }); return current;
      }
    } catch { /* Missing or invalid path record requires discovery. */ }
    current = findZCode(options);
    if (valid(current.bundle)) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const temp = file + '.' + randomUUID() + '.tmp';
      writeFileSync(temp, JSON.stringify({ version: 1, bundle: current.bundle }), { encoding: 'utf8', mode: 0o600 }); renameSync(temp, file);
    }
    observe({ event: 'zcode-path-search', bundle: current.bundle, method: current.method, forced: force });
    return current;
  };
}
let locate = createZCodeLocator(join(homedir(), '.local/share/bb-zcode'));
export function configureZCodeLocation(root: string, observe?: (value: Record<string, unknown>) => void) { locate = createZCodeLocator(root, {}, observe); }
export function resolveZCode(force = false) { return locate(force); }
// Explicit lazy lookup: importing the server never searches for ZCode.
export function nativePaths() { return pathsForZCode(resolveZCode().bundle ?? '/ZCode-not-found.app'); }
export const shellQuote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
export function loginCommand(paths = nativePaths(), args: readonly string[] = ['login', 'zai']): string {
  return `ELECTRON_RUN_AS_NODE=1 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=${shellQuote(paths.builtin)} ${[paths.executable, paths.script, ...args].map(shellQuote).join(' ')}`;
}
export function signInHint(_paths?: ReturnType<typeof pathsForZCode>): string {
  return 'Open ZCode Desktop and sign in again to your individual Z.ai Coding Plan, then retry in bb. Your next turn reads the shared sign-in automatically.';
}
