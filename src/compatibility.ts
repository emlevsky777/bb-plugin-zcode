import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { bbBundle } from './applications.ts';

export interface CompatibilityTuple {
  bb: string | null; installedSdk: string | null; declaredSdk: string;
  desktop: string | null; cli: string | null; runtimeSha256: string | null; builtinSha256: string | null;
  bbArtifactSha256: string | null; sdkArtifactSha256: string | null;
  platform: string; arch: string; node: string;
}
export interface CheckedTuple { tuple: CompatibilityTuple; pluginRevision: string; resultRef: string; evidenceRef: string; level: string }
export function fileIdentity(files: readonly string[]): string {
  return JSON.stringify(files.map(path => {
    try { const s = statSync(path, { bigint: true }); return [path, s.dev.toString(), s.ino.toString(), s.size.toString(), s.mtimeNs.toString(), s.ctimeNs.toString()]; }
    catch (error) { return [path, 'unavailable', (error as NodeJS.ErrnoException).code ?? 'unknown']; }
  }));
}
// Installation metadata only. Never cache credential values or auth errors.
export function createFileIdentityCache<T>(files: readonly string[], load: () => T,
  options: { now?: () => number; ttlMs?: number } = {}): () => T {
  const now = options.now ?? (() => performance.now()), ttl = options.ttlMs ?? 29 * 60_000;
  if (!(ttl > 0 && ttl <= 29 * 60_000)) throw new Error('Discovery TTL must be within 29 minutes');
  let cached: { stamp: string; at: number; value: T } | undefined;
  return () => {
    const stamp = fileIdentity(files);
    const at = now();
    if (cached && cached.stamp === stamp && at >= cached.at && at - cached.at < ttl) return cached.value;
    // A failed reload cannot leave an older trusted tuple available.
    cached = undefined;
    const value = load(); cached = { stamp, at, value }; return value;
  };
}
const bbRoot = `${bbBundle() ?? '/bb-not-found.app'}/Contents/Resources/app.asar/node_modules/bb-app`;
export function compatibilityFiles(paths: { executable: string; script: string }) { return [`${bbBundle() ?? '/bb-not-found.app'}/Contents/Resources/app.asar`, bbRoot + '/package.json', bbRoot + '/server/dist/start-server.js',
  paths.script.replace('/Contents/Resources/glm/zcode.cjs', '/Contents/Info.plist'),
  paths.executable.replace('/Contents/MacOS/ZCode Helper', '/Contents/Info.plist'),
  paths.script.replace('/glm/zcode.cjs', '/config/provider/zcode-builtin.json')]; }
export const compatibilityReference = {
  "bb": "0.47.1",
  "installedSdk": "0.6.79",
  "declaredSdk": "0.6.79",
  "desktop": "3.15.1",
  "cli": "0.16.9",
  "runtimeSha256": "b816e38656e70fb585fe2ab1ea010da89cda928dac1ccb5d83255fd18796da6e",
  "builtinSha256": "18f80aed398652090bb23f50b11f23c321b23590395b3e4af9494f6f0eca00c6",
  "bbArtifactSha256": "466055f490e9594140177b76fab95980d2baabf132957fd40a2eade8884d166a",
  "sdkArtifactSha256": "7107e7dc8f5ddc377a3fc74d669d7899b3b41bc53d516edb185acc007d2ff77b",
  "platform": "darwin",
  "arch": "arm64",
  "node": "24.22.0",
  "level": "level1",
  "evidenceRef": "README.md#compatibility"
};
// Owner accepted audit 2 and the blank-page Notion read on 26 October 2026.
export const checkedTuples: readonly CheckedTuple[] = [{
  tuple: compatibilityReference,
  pluginRevision: 'c65a1db',
  resultRef: 'README.md#compatibility',
  evidenceRef: 'compat/M4.9.8c.1b-artifacts.json',
  level: 'level1',
}, {
  // Owner accepted M5.4 and authorized registration after the cheap post-Stop
  // continuation passed. Automatic-compaction success remains unproven.
  tuple: {
    bb: '0.48.0', installedSdk: '0.6.94', declaredSdk: '0.6.79',
    desktop: '3.16.3', cli: '0.17.0', node: '24.22.0', platform: 'darwin', arch: 'arm64',
    runtimeSha256: '97490d0f06a7a225d54d47817acf4b4859cdb268b59f2490caaeda982bef063a',
    builtinSha256: '361b778f89496a37540d23a9d309efe6cb8fc97d557119cefbffc67df2f93998',
    bbArtifactSha256: '0e5c47dd6dc47a59a4ccf8cb4fe6411df04ab99f536eacd5f4b0990d81ff0bf6',
    sdkArtifactSha256: 'c98d4ebaf5f9605df8ea4cf18d5097cb59b8e0f197c3156e33c29bc257b0f4bf',
  },
  pluginRevision: 'aecaf5a',
  resultRef: 'README.md#compatibility',
  evidenceRef: 'compat/M5.4-artifacts.json',
  level: 'level1',
}];
const version = (v: unknown): string | null => typeof v === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(v) ? v : null;
export function desktopVersion(file: string): string | null {
  try {
    const xml = version(readFileSync(file, 'utf8').match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1]);
    if (xml) return xml;
  } catch { /* Missing XML or binary plist: try the system reader. */ }
  try { return version(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', file],
    { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()); }
  catch { return null; }
}
export function compareCompatibility(tuple: CompatibilityTuple, table: readonly CheckedTuple[] = checkedTuples) {
  const keys = Object.keys(tuple) as (keyof CompatibilityTuple)[];
  const match = table.find(row => row.level === 'level1' && row.resultRef && row.evidenceRef && row.pluginRevision &&
    keys.every(key => tuple[key] !== null && tuple[key] === row.tuple[key]));
  const known = Boolean(match);
  return { known, resultRef: match?.resultRef ?? null, tuple,
    message: known ? null : `This version combination has not been checked: bb ${tuple.bb ?? 'unknown'}, SDK ${tuple.installedSdk ?? 'unknown'} (declared ${tuple.declaredSdk}), ZCode Desktop ${tuple.desktop ?? 'unknown'}, CLI ${tuple.cli ?? 'unknown'}. You can continue. If startup or conversation fails, contact the plugin maintainer.` };
}
export function discoverCompatibility(paths: { executable: string; script: string }, runtimeSha256: string | null): CompatibilityTuple {
  const safe = <T>(fn: () => T): T | null => { try { return fn(); } catch { return null; } };
  const bbPackage = safe(() => readFileSync(bbRoot + '/package.json'));
  const sdkArtifact = safe(() => readFileSync(bbRoot + '/server/dist/start-server.js'));
  const sha = (bytes: Buffer | null) => bytes ? createHash('sha256').update(bytes).digest('hex') : null;
  const bb = safe(() => version(JSON.parse(bbPackage!.toString('utf8')).version));
  const installedSdk = version(sdkArtifact?.toString('utf8').match(/\bPLUGIN_SDK_VERSION\s*=\s*"([^"]+)"/)?.[1]);
  const desktop = desktopVersion(compatibilityFiles(paths)[3]!);
  // Local --version only, never app-server/auth/network/model compatibility probes.
  const cli = version(safe(() => execFileSync(paths.executable, [paths.script, '--version'], {
    env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 3000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim().replace(/^zcode\s+/i, '')));
  return { bb, installedSdk, declaredSdk: '0.6.79', desktop, cli, runtimeSha256, builtinSha256: sha(safe(() => readFileSync(compatibilityFiles(paths)[5]!))),
    bbArtifactSha256: sha(bbPackage), sdkArtifactSha256: sha(sdkArtifact), platform: process.platform, arch: process.arch, node: process.versions.node };
}
