import { openSync, readSync, closeSync, readFileSync, existsSync, fstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { configureZCodeLocation, nativePaths, resolveZCode } from './applications.ts';
import { discoverCompatibility } from './compatibility.ts';

const eventCodes = new Set(['protocol-diagnostic', 'native-startup', 'native-mcp-startup-observed', 'catalogue-cleanup',
  'native-mcp-degraded', 'native-mcp-log-incomplete', 'native-mcp-pending',
  'catalogue-cleanup-error', 'catalogue-cache-recovery', 'auth-overlay-refresh', 'overlay-ack-only',
  'zcode-path-search', 'zcode-path-cache-hit', 'native-process-identity', 'subagent-setting']);
const diagnosticCodes = new Set(['generic-native-tool', 'unknown-native-event', 'unknown-service-error', 'unrelated-native-stdout']);
function tailEvents(file: string): Record<string, unknown>[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    // Bounded tail, no raw event text leaves this module.
    const size = fstatSync(fd).size; const buf = Buffer.alloc(Math.min(size, 64 * 1024));
    readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    return buf.toString('utf8').split('\n').flatMap(line => {
      try { const value = JSON.parse(line); return value && typeof value === 'object' && !Array.isArray(value) ? [value] : []; }
      catch { return []; }
    });
  } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
}
export function reportEvents(root: string): string[] {
  const codes = tailEvents(join(root, 'service-evidence.ndjson')).flatMap(value => eventCodes.has(String(value.event))
    ? [value.event === 'protocol-diagnostic' && diagnosticCodes.has(String(value.code)) ? value.event + ':' + value.code : String(value.event)] : []);
  // MCP startup is asynchronous and can finish after session-ready observation.
  // Read native diagnostics at report time; emit only fixed codes, never bodies.
  try {
    for (const generation of readdirSync(join(root, 'generations'))) {
      const logs = join(root, 'generations', generation, 'logs');
      let files: string[]; try { files = readdirSync(logs); } catch { continue; }
      for (const file of files.filter(name => name.endsWith('.jsonl'))) for (const value of tailEvents(join(logs, file))) {
        if (value.event === 'mcp.startup.failed' || value.event === 'mcp.startup.completed' &&
            Number((value.context as { statusCounts?: { failed?: unknown } } | undefined)?.statusCounts?.failed ?? 0) > 0)
          codes.push('native-mcp-degraded');
      }
    }
  } catch { /* Optional native diagnostic logs. */ }
  return codes.slice(-20);
}

export function settingsReport(settings: Record<string, unknown>) {
  return {
    authMode: settings.authMode === 'coding-plan-key' ? 'coding-plan-key' : 'cli',
    backupKey: typeof settings.backupKey === 'string' && !!settings.backupKey ? 'set' : 'not set',
    subagentsDisabled: settings.subagentsDisabled === true,
    memoryEnabled: settings.memoryEnabled !== false,
  };
}
export function redactHomePath(path: string | null, home = homedir()) {
  return path === home ? '~' : path?.startsWith(home + '/') ? '~' + path.slice(home.length) : path;
}
export function localProblemReport(root: string) {
  configureZCodeLocation(root);
  const location = resolveZCode(), tuple = discoverCompatibility(nativePaths(), null);
  let macOS = 'unknown';
  try { macOS = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Fixed fallback. */ }
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
  return 'ZCode problem report (server-local; not remote-agent diagnostics)\n' + JSON.stringify(problemReport(local, settings), null, 2) + '\n';
}
export function problemReport(local: ReturnType<typeof localProblemReport>, settings: Record<string, unknown>) {
  const version = (value: unknown) => typeof value === 'string' && /^\d{1,6}\.\d{1,6}(?:\.\d{1,6})?$/.test(value) ? value : null;
  return { scope: 'server-local', remoteAgentDiagnostics: false, bb: version(local.bb), ZCode: version(local.ZCode),
    CLI: version(local.CLI), plugin: version(local.plugin), macOS: version(local.macOS), pluginState: 'running',
    state: local.state === 'installed' ? 'installed' : 'not installed',
    desktopCredentialFile: local.cliLogin === 'set' ? 'present' : 'absent',
    signInReadiness: 'not checked',
    events: local.events.filter(code => eventCodes.has(code) || code.startsWith('protocol-diagnostic:') &&
      diagnosticCodes.has(code.slice('protocol-diagnostic:'.length))).slice(-20), settings: settingsReport(settings) };
}
