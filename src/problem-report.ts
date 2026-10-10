import { openSync, readSync, closeSync, readFileSync, existsSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { configureZCodeLocation, nativePaths, resolveZCode } from './applications.ts';
import { discoverCompatibility } from './compatibility.ts';

const eventCodes = new Set(['protocol-diagnostic', 'native-startup', 'native-session-ready', 'catalogue-cleanup',
  'catalogue-cleanup-error', 'catalogue-cache-recovery', 'auth-overlay-refresh', 'overlay-ack-only',
  'zcode-path-search', 'zcode-path-cache-hit', 'native-process-identity', 'subagent-setting']);
const diagnosticCodes = new Set(['generic-native-tool', 'unknown-native-event', 'unknown-service-error', 'projection-limit']);
export function reportEvents(root: string): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(join(root, 'service-evidence.ndjson'), 'r');
    // Bounded tail, no raw event text leaves this module.
    const size = fstatSync(fd).size; const buf = Buffer.alloc(Math.min(size, 64 * 1024));
    readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    return buf.toString('utf8').split('\n').flatMap(line => {
      try { const value = JSON.parse(line); return eventCodes.has(value.event)
        ? [value.event === 'protocol-diagnostic' && diagnosticCodes.has(value.code) ? value.event + ':' + value.code : value.event] : []; }
      catch { return []; }
    }).slice(-20);
  } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
}

export function settingsReport(settings: Record<string, unknown>) {
  return {
    authMode: settings.authMode === 'coding-plan-key' ? 'coding-plan-key' : 'cli',
    backupKey: typeof settings.backupKey === 'string' && !!settings.backupKey ? 'set' : 'not set',
    subagentsDisabled: settings.subagentsDisabled === true,
    useZCodePlugins: settings.useZCodePlugins === true,
    useUserMcp: false,
  };
}
export function redactHomePath(path: string | null, home = homedir()) {
  return path === home ? '~' : path?.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}
export function localProblemReport(root: string) {
  configureZCodeLocation(root);
  const location = resolveZCode(), tuple = discoverCompatibility(nativePaths(), null);
  let macOS = 'unknown';
  try { macOS = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 2000 }).trim(); } catch { /* Fixed fallback. */ }
  let cliLogin = false;
  // Presence only: credentials remain read-only and are never serialized.
  try { cliLogin = existsSync(join(homedir(), '.zcode/v2/credentials.json')); } catch { /* unavailable */ }
  let pluginVersion = 'unknown';
  try { const value = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    if (typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value)) pluginVersion = value; } catch { /* bundled version fallback */ }
  return { bb: tuple.bb, ZCode: tuple.desktop, CLI: tuple.cli, plugin: pluginVersion, macOS,
    state: location.bundle ? 'installed' : 'not installed', ZCodePath: location.bundle,
    cliLogin: cliLogin ? 'set' : 'not set', events: reportEvents(root) };
}
export function formatProblemReport(local: ReturnType<typeof localProblemReport>, settings: Record<string, unknown>) {
  return 'ZCode problem report\n' + JSON.stringify({ bb: local.bb, ZCode: local.ZCode, CLI: local.CLI,
    plugin: local.plugin, macOS: local.macOS, pluginState: 'running', state: local.state, ZCodePath: redactHomePath(local.ZCodePath),
    cliLogin: local.cliLogin, events: local.events, settings: settingsReport(settings) }, null, 2) + '\n';
}
