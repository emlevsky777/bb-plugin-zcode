import { existsSync, readFileSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, appendFileSync, unlinkSync, realpathSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { preparePersonalSettings } from './personal-settings.ts';
import { readUserPlugins, applyUserPlugins, optionalUserPlugins } from './user-plugins.ts';
import { assertEmptyWorkspaceTrust, assertOffPluginCatalogue, assertOfficialLaunchIsolation } from './plugin-isolation.ts';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { reasoningLevelSchema, providerHealthResultSchema, providerInstallationStatusSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { ReadOnlyAuth, AuthError, accountProviderId } from './auth.ts';
import type { AuthMode } from './auth.ts';
import { NativeProcess, childEnvironment, MissingExecutableError } from './process.ts';
import { record, string } from './errors.ts';
import { scheduleDataMaintenance } from './data-maintenance.ts';
import { observerEnvironment } from './observer.ts';
import { runtimePreferences } from './bridge.ts';
import type { BridgeServices, RuntimeSetup } from './bridge.ts';
import type { executionOptions } from './options.ts';
import { discoverCompatibility, compareCompatibility, createFileIdentityCache, compatibilityFiles, fileIdentity } from './compatibility.ts';
import { nativePaths, loginCommand, signInHint, configureZCodeLocation, resolveZCode } from './applications.ts';
import { claimNotice, diagnosticNoticeName } from './messages.ts';
export { nativePaths } from './applications.ts';
// Match Desktop's installed host/CLI executable identity. The main executable
// registers CLI/MCP children as dev.zcode.app/Foreground in LaunchServices.
// The supplied helper is dev.zcode.app.helper/UIElement (Desktop 3.14.4).
// A missing helper is an installation error; never fall back to the main app.
export const supportedRuntimeSha = 'fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f';
export async function waitNativeMcpReady(logs: string, child: NativeProcess, id: string,
  observe: (value: Record<string, unknown>) => void, timeout = 20_000, disabledServerCount = 0): Promise<void> {
  if (!Number.isSafeInteger(disabledServerCount) || disabledServerCount < 0) throw Error('Invalid planned MCP exclusions');
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child.child.exitCode !== null || child.child.signalCode !== null) throw new Error('Native startup died before MCP readiness');
    for (const file of readdirSync(logs).filter(f => f.endsWith('.jsonl'))) for (const line of readFileSync(join(logs, file), 'utf8').split('\n').filter(Boolean)) {
      let event: Record<string, unknown>;
      try { event = record(JSON.parse(line)); } catch { continue; }
      if (event.sessionId !== id) continue;
      if (event.event === 'mcp.startup.failed') throw new Error('Native MCP startup failed; reconcile configured MCP services, then attach the original bb thread again. Keep native ID, HOME and history.');
      if (event.event !== 'mcp.startup.completed') continue;
      const context = record(event.context), counts = record(context.statusCounts);
      if (!Number.isSafeInteger(context.serverCount) || Number(context.serverCount) < 0 ||
          !Number.isSafeInteger(counts.connected ?? 0) || !Number.isSafeInteger(counts.disabled ?? 0) ||
          (counts.disabled ?? 0) !== disabledServerCount ||
          Number(counts.connected ?? 0) + disabledServerCount !== context.serverCount ||
          Object.entries(counts).some(([name, count]) => !['connected', 'disabled'].includes(name) && count !== 0))
        throw new Error('Native MCP readiness unconfirmed; reconcile configured MCP services before attaching the original bb thread again. Keep native ID, HOME and history.');
      observe({ event: 'native-session-ready', sessionId: id, pid: child.child.pid,
        generation: child.generation, serverCount: context.serverCount, connected: counts.connected ?? 0,
        ...(disabledServerCount ? { disabled: disabledServerCount } : {}) });
      return;
    }
    await delay(20);
  }
  throw new Error('Native MCP startup readiness timed out; reconcile before retry');
}
export async function verifyNativePluginState(logs: string, child: NativeProcess, id: string, cwd: string,
  pluginStore: string, off: boolean, observe: (value: Record<string, unknown>) => void, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child.child.exitCode !== null || child.child.signalCode !== null) throw Error('ZCode plugin startup died; thread stopped before input');
    let completed = false, plugins: Record<string, unknown> | undefined;
    for (const file of readdirSync(logs).filter(f => f.endsWith('.jsonl'))) for (const line of readFileSync(join(logs, file), 'utf8').split('\n').filter(Boolean)) {
      let event: Record<string, unknown>;
      try { event = record(JSON.parse(line)); } catch { continue; }
      if (event.sessionId !== id) continue;
      if (event.event === 'bootstrap.app.startup.completed') completed = true;
      if (event.event === 'bootstrap.app.startup.plugins.completed') plugins = record(event.context);
    }
    if (completed && plugins) {
      if (plugins.pluginStorageRoot !== pluginStore || !Number.isSafeInteger(plugins.hookCount) || Number(plugins.hookCount) < 0 || (off && plugins.hookCount !== 0))
        throw Error('ZCode plugin storage or OFF hooks disagree with the isolation plan; thread stopped before input');
      const catalogue = await child.request('plugins/referenceCatalog', { sessionId: id, workspace: { workspacePath: cwd, workspaceKey: cwd } });
      if (off) assertOffPluginCatalogue(catalogue);
      observe({ event: 'native-plugin-guard', sessionId: id, generation: child.generation, mode: off ? 'off' : 'on',
        pluginStorageRoot: plugins.pluginStorageRoot, hookCount: plugins.hookCount, catalogue });
      return catalogue;
    }
    await delay(20);
  }
  throw Error('ZCode plugin loaded state is unavailable; thread stopped before input');
}
export function writeSessionInstructions(ownHome: string, instructions: string) {
  const file = join(ownHome, '.zcode/AGENTS.md');
  if (!instructions) { if (existsSync(file)) unlinkSync(file); return; }
  mkdirSync(join(ownHome, '.zcode'), { recursive: true, mode: 0o700 });
  writeFileSync(file, instructions, { encoding: 'utf8', mode: 0o600 });
}
export function sessionHome(root: string, _cwd: string, threadId: string) {
  // Native session disk state also lives under HOME. Preserve it across process
  // replacement while keeping instructions isolated between bb threads.
  if (!threadId || !threadId.trim()) throw new Error('Canonical thread identity required');
  return join(root, 'thread-homes-v2', createHash('sha256').update(threadId).digest('hex'));
}
let cachedDiscovery: (() => { installed: boolean; supported: boolean; sha256: string | null; version: string | null; tuple?: ReturnType<typeof discoverCompatibility> }) | undefined;
let discoveryPaths = '';
export function discovery() {
  const paths = nativePaths();
  const identity = JSON.stringify(paths);
  if (!cachedDiscovery || discoveryPaths !== identity) {
    discoveryPaths = identity;
    cachedDiscovery = createFileIdentityCache([...Object.values(paths), ...compatibilityFiles(paths)], () => {
  const installed = Object.values(paths).every(existsSync);
  if (!installed) return { installed, supported: false, sha256: null, version: null };
  const sha256 = createHash('sha256').update(readFileSync(paths.script)).digest('hex');
  const tuple = discoverCompatibility(paths, sha256);
  return { installed, supported: sha256 === supportedRuntimeSha, sha256, version: tuple.cli, tuple };
    });
  }
  return cachedDiscovery();
}
export function mapNativeModels(value: unknown, nativeDefault?: unknown) {
  if (!Array.isArray(value)) throw new Error('Native catalogue missing');
  const output: { id: string; model: string; displayName: string; description: string; isDefault: boolean;
    defaultReasoningEffort: string; supportedReasoningEfforts: { reasoningEffort: string; description: string }[]; supportsImage?: boolean }[] = [];
  const rejected = new Set<string>(), seen = new Set<string>();
  for (const item of value) {
    const m = record(item), ref = record(m.ref);
    if (ref.providerId !== accountProviderId) continue;
    // isr/session settings schema exposes disabled native models in the list.
    if (m.disabledReason !== undefined) {
      if (typeof m.disabledReason !== 'string' || !m.disabledReason.trim()) throw new Error('Malformed native model availability');
      continue;
    }
    const reasoning = record(m.reasoning);
    if (!Array.isArray(reasoning.levels) || !reasoning.levels.length || typeof reasoning.defaultLevel !== 'string') throw new Error('Native reasoning default unavailable');
    const levels = reasoning.levels.map(v => string(record(v).value));
    if (levels.some(v => !v.trim()) || new Set(levels).size !== levels.length || !levels.includes(reasoning.defaultLevel)) throw new Error('Malformed native reasoning catalogue');
    const model = string(ref.modelId);
    if (!model.trim() || seen.has(model)) throw new Error('Malformed or duplicate native model');
    seen.add(model);
    if (!reasoningLevelSchema.safeParse(reasoning.defaultLevel).success) {
      rejected.add(model);
      process.stderr.write(`ZCode model ${model}: default reasoning unsupported by bb SDK; model unavailable.\n`);
      continue;
    }
    const inputFormat = record(record(m.properties ?? {}).inputFormat ?? {});
    if (inputFormat.supportsImage !== undefined && typeof inputFormat.supportsImage !== 'boolean') throw new Error('Malformed native image capability');
    output.push({ id: model, model, displayName: typeof m.label === 'string' ? m.label : model, description: 'ZCode native account Coding Plan model', isDefault: false, defaultReasoningEffort: reasoning.defaultLevel, supportedReasoningEfforts: levels.filter(level => reasoningLevelSchema.safeParse(level).success).map(level => ({ reasoningEffort: level, description: level })), ...(typeof inputFormat.supportsImage === 'boolean' ? { supportsImage: inputFormat.supportsImage } : {}) });
  }
  if (!output.length) throw new Error(rejected.size ? 'Native model default reasoning unsupported by bb SDK; no supported models' : 'Native Coding Plan catalogue empty');
  const fallback = record(nativeDefault ?? {});
  const selected = output.find(m => m.model === 'GLM-5.3') ?? (fallback.providerId === accountProviderId ? output.find(m => m.model === fallback.modelId) : undefined);
  if (!selected && !rejected.has(String(fallback.modelId)) && !rejected.has('GLM-5.3')) throw new Error('Native Coding Plan default unavailable; no invented fallback');
  if (selected) selected.isDefault = true;
  return output;
}
export function createNativeServices(initialRoot = join(homedir(), '.local/share/bb-zcode'), dependencies: {
  discovery?: typeof discovery; auth?: ReadOnlyAuth; paths?: ReturnType<typeof nativePaths>;
  configure?: (child: NativeProcess) => Promise<void>;
  catalogueCache?: boolean;
  personalHome?: string;
  compatibility?: () => ReturnType<typeof compareCompatibility>;
} = {}) {
  let root = resolve(initialRoot);
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  let explicitKeyPath: string | undefined;
  let catalogueEpoch = 0, stopped = false;
  type Catalogue = { models: ReturnType<typeof mapNativeModels> };
  let catalogue: Catalogue | undefined;
  let catalogueScope: string | undefined;
  let loading: { epoch: number; promise: Promise<Catalogue> } | undefined;
  const catalogueLoads = new Set<Promise<Catalogue>>();
  let locationConfigured = false;
  const detect = dependencies.discovery ?? (() => {
    if (!locationConfigured) { configureZCodeLocation(root, evidence); locationConfigured = true; }
    return discovery();
  });
  const getPaths = () => dependencies.paths ?? nativePaths();
  const compatibility = () => dependencies.compatibility?.() ?? (() => {
    const d = detect(); return compareCompatibility('tuple' in d ? d.tuple! : discoverCompatibility(getPaths(), d.sha256));
  })();
  const children = new Set<NativeProcess>();
  const evidence = (value: Record<string, unknown>, evidenceRoot = root) => {
    mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
    appendFileSync(join(evidenceRoot, 'service-evidence.ndjson'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { encoding: 'utf8', mode: 0o600 });
  };
  const auth = dependencies.auth ?? new ReadOnlyAuth(undefined, undefined, (purpose, generation) => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    appendFileSync(join(root, 'auth-metadata.ndjson'), JSON.stringify({ at: new Date().toISOString(), purpose, generation, fresh: true }) + '\n', { encoding: 'utf8', mode: 0o600 });
  });
  const selectedAuth = (mode: AuthMode = 'cli') => dependencies.auth && mode === 'cli' ? auth : auth.fork(mode, explicitKeyPath);
  // A bb maintenance bridge may expire independently of a live thread bridge.
  // Share only the validated public catalogue, never credentials/identity/hash.
  // Pinned account capabilities are public config; authentication is checked
  // independently on every hit and every model request, never part of the key.
  const persistentCatalogue = dependencies.catalogueCache ?? !dependencies.configure;
  function cacheScope(d: ReturnType<typeof discovery>, mode: AuthMode = 'cli', refresh = 0): string {
    const paths = getPaths();
    const scope = JSON.stringify({ version: 3, semantics: 'zai-coding-plan-session-create-v1', root, runtime: d.sha256, cli: d.version, mode, refresh,
      credentialFileIdentity: fileIdentity(mode === 'cli' ? [auth.path] : explicitKeyPath ? [explicitKeyPath] : []),
      builtin: createHash('sha256').update(readFileSync(paths.builtin)).digest('hex') });
    selectedAuth(mode).read('catalogue-cache-validation');
    return scope;
  }
  async function cachedCatalogue(loadRoot: string, scope: string, epoch: number, mode: AuthMode, refresh: number): Promise<Catalogue> {
    mkdirSync(loadRoot, { recursive: true, mode: 0o700 });
    const file = join(loadRoot, 'catalogue-v2.json');
    let invalid: string | undefined;
    const readCache = (): Catalogue | undefined => {
      try {
      let value: Record<string, unknown>;
      let text: string;
      try { text = readFileSync(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { invalid = 'missing-public-cache'; return; }
        throw new Error('Catalogue cache inaccessible');
      }
      value = record(JSON.parse(text));
      if (Object.keys(value).sort().join(',') !== 'catalogue,scope' || typeof value.scope !== 'string') throw new Error('Catalogue cache envelope invalid');
      if (value.scope !== scope) { invalid = 'stale-public-cache'; return; }
      const raw = record(value.catalogue), models = raw.models;
      if (!Array.isArray(models)) throw new Error('Catalogue cache invalid');
      const normalized = mapNativeModels(models.map(model => {
        const m = record(model);
        return { label: m.displayName, ref: { providerId: accountProviderId, modelId: m.model }, properties: { inputFormat: { supportsImage: m.supportsImage } }, reasoning: { defaultLevel: m.defaultReasoningEffort,
          levels: Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.map(e => ({ value: record(e).reasoningEffort })) : [] } };
      }), { providerId: accountProviderId, modelId: record(models.find(m => record(m).isDefault === true)).model });
      if (JSON.stringify(raw) !== JSON.stringify({ models: normalized })) throw new Error('Catalogue cache shape changed');
      evidence({ event: 'catalogue-shared-cache-hit' }, loadRoot);
      return { models: normalized };
      } catch (error) {
        if (error instanceof Error && error.message === 'Catalogue cache inaccessible')
          throw new Error('Catalogue cache inaccessible; restore access to provider data directory and restart provider. Keep sessions/history.');
        invalid = 'invalid-public-cache'; return;
      }
    };
    const hit = readCache(); if (hit) return hit;
    if (invalid) evidence({ event: 'catalogue-cache-recovery', reason: invalid,
      action: 'Reloading validated catalogue from ZCode; session/history retained' }, loadRoot);
    const value = await loadCatalogue(loadRoot, mode);
    if (stopped || epoch !== catalogueEpoch || root !== loadRoot || cacheScope(detect(), mode, refresh) !== scope)
      throw new Error('Catalogue root changed or runtime/config scope changed; retry after reconciliation');
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify({ scope, catalogue: value }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temp, file);
    } catch {
      throw new Error('Catalogue cache publication failed; restore access to provider data directory and restart provider. Keep sessions/history.');
    } finally { if (existsSync(temp)) unlinkSync(temp); }
    return value;
  }
  async function prepare(cwd: string, execution?: ReturnType<typeof executionOptions>, identity?: { threadId: string; providerThreadId?: string }, service = false, serviceMode: AuthMode = 'cli'): Promise<RuntimeSetup> {
    const operationRoot = root;
    // Identity and binding checks precede discovery, auth and writes.
    const threadId = identity?.threadId;
    if (!service && (!threadId || !threadId.trim())) throw new Error('Canonical thread identity required; attach from the original bb thread. Keep session/history files.');
    if (!service && execution?.envVars.BB_THREAD_ID !== undefined && execution.envVars.BB_THREAD_ID !== threadId)
      throw new Error('Environment thread identity conflict; remove manual BB_THREAD_ID override and attach from the original bb thread.');
    try { cwd = realpathSync(cwd); } catch { throw new Error('Workspace binding path unavailable; restore original workspace directory and attach again. Keep session/history files.'); }
    const ownHome = service ? join(root, 'catalogue-homes', randomUUID()) : sessionHome(root, cwd, threadId!);
    const bindingFile = join(ownHome, 'bb-binding.json');
    let binding: Record<string, unknown> | null;
    try { binding = existsSync(bindingFile) ? record(JSON.parse(readFileSync(bindingFile, 'utf8'))) : null; }
    catch { throw new Error('Native binding unreadable; keep binding/session/history files and ask the provider maintainer to reconcile the original native identity before attach.'); }
    if (!service && binding && binding.threadId !== threadId) throw new Error('Canonical thread binding identity conflict; keep binding/session/history files and ask the provider maintainer to reconcile the original identity.');
    if (!service && binding && binding.cwd !== resolve(cwd)) throw new Error('Workspace binding conflict; restore original cwd');
    if (!service && identity?.providerThreadId && (!binding || binding.nativeSessionId !== identity.providerThreadId))
      throw new Error('Unknown or legacy native identity; keep binding/session/history files and ask the provider maintainer to reconcile the original native identity before attach. No migration.');
    if (!service && !identity?.providerThreadId && (binding?.nativeSessionId || binding?.creationPending))
      throw new Error('Existing native identity requires resume; no create fallback. Attach the original bb thread with its saved native ID. If creation is pending, ask the provider maintainer to reconcile it; keep binding/session/history files.');
    const d = detect(), paths = getPaths();
    if (!d.installed) throw new MissingExecutableError(resolveZCode().message);
    const sessionAuth = selectedAuth(execution?.authMode ?? serviceMode);
    sessionAuth.read('prepare');
    let builtinRevision: string | null = null;
    const generationRoot = join(root, 'generations', randomUUID()), logs = join(generationRoot, 'logs');
    const dataRoot = join(root, 'data');
    for (const dir of [root, dataRoot, ownHome, logs]) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const personalLayer = service ? undefined : preparePersonalSettings(ownHome, dataRoot, cwd, dependencies.personalHome ?? homedir());
    let pluginPreload: string | undefined, disabledServerCount = 0, pluginStore: string | undefined, pluginsOff = true;
    if (service) {
      mkdirSync(join(ownHome, '.zcode/cli'), { recursive: true, mode: 0o700 });
      writeFileSync(join(ownHome, '.zcode/cli/config.json'), JSON.stringify({ storage: { dir: dataRoot }, hooks: { enabled: false }, memory: { use: false } }), { mode: 0o600 });
      const plan = applyUserPlugins(ownHome, dataRoot, cwd, false);
      pluginPreload = plan.preload;
    } else {
      const { enabled, plugins } = await optionalUserPlugins(execution?.useZCodePlugins === true,
        () => readUserPlugins(cwd, paths, dependencies.personalHome ?? homedir(), undefined, value => evidence(value, operationRoot)), personalLayer!.warnings);
      const pluginPlan = applyUserPlugins(ownHome, dataRoot, cwd, enabled, plugins, execution?.providerSubagentsEnabled !== false);
      pluginPreload = pluginPlan.preload; disabledServerCount = pluginPlan.disabledServerCount;
      pluginStore = pluginPlan.pluginStore; pluginsOff = !enabled;
      assertEmptyWorkspaceTrust(ownHome, dataRoot);
    }
    writeSessionInstructions(ownHome, execution?.instructions ?? '');
    if (!service && personalLayer) {
      const config = { ...record(JSON.parse(readFileSync(personalLayer.configPath, 'utf8'))),
        features: { subagent: execution?.providerSubagentsEnabled !== false } };
      writeFileSync(personalLayer.configPath, JSON.stringify(config) + '\n', { mode: 0o600 });
      evidence({ event: 'subagent-setting', threadId, enabled: execution?.providerSubagentsEnabled !== false }, operationRoot);
    }
    if (!service && !binding) writeFileSync(bindingFile, JSON.stringify({ threadId, cwd: resolve(cwd), nativeSessionId: null }), { encoding: 'utf8', mode: 0o600 });
    const builtin = join(dataRoot, 'zcode-builtin.json'), personal = join(dataRoot, 'provider-config.json');
    if (!existsSync(builtin)) copyFileSync(paths.builtin, builtin);
    if (!existsSync(personal)) writeFileSync(personal, JSON.stringify({ schemaVersion: 1, revision: 'bb-zcode-empty', config: { providerConfigRules: { providerRules: [] } } }), { encoding: 'utf8', mode: 0o600 });
    const own: NodeJS.ProcessEnv = { HOME: ownHome, TMPDIR: '.', ELECTRON_RUN_AS_NODE: '1', ZCODE_DATA_BASE_DIR: dataRoot, ZCODE_LOG_DIR: logs, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin, ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: paths.builtin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal };
    const observer = join(root, 'observer.json');
    own.ZCODE_STORAGE_DIR = dataRoot;
    own.ZCODE_SESSION_DB_PATH = join(ownHome, '.zcode/cli/db/db.sqlite');
    Object.assign(own, observerEnvironment(root));
    const warnings = personalLayer?.warnings ?? [];
    const launchEnv = { ...childEnvironment(process.env, own), ...execution?.envVars, ...(!service ? { BB_THREAD_ID: threadId } : {}) };
    return { warnings, auth: sessionAuth, mentionCatalogue: service ? undefined : async side => {
      try {
        const { stdout } = await promisify(execFile)(paths.executable,
          [...(pluginPreload ? ['--require', pluginPreload] : []), paths.script, '--json', side, 'list'],
          { cwd, env: launchEnv, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
        return JSON.parse(stdout) as unknown;
      } catch { throw Error('Native mention catalogue unavailable. Ordinary messages are still available.'); }
    }, beforeInput: service ? undefined : async () => {
      const trust = assertEmptyWorkspaceTrust(ownHome, dataRoot);
      evidence({ event: 'workspace-hook-trust-guard', records: trust.records, present: trust.present }, operationRoot);
    }, refreshAuth: async child => {
      if (dependencies.configure) { sessionAuth.read('refresh'); return; }
      if (!builtinRevision) throw new Error('Runtime builtin revision unavailable; no auth refresh');
      await child.request('provider/updateAccountConfig', sessionAuth.overlay(`bb-${randomUUID()}`, builtinRevision));
      evidence({ event: 'auth-overlay-refresh', source: sessionAuth.source(), route: 'coding-plan-gateway', pid: child.child.pid }, operationRoot);
    }, markCreatePending: service ? undefined : () => {
      writeFileSync(bindingFile, JSON.stringify({ threadId, cwd, nativeSessionId: null, creationPending: true }), { encoding: 'utf8', mode: 0o600 });
    }, bindSession: service ? undefined : (nativeSessionId: string) => {
      writeFileSync(bindingFile, JSON.stringify({ threadId, cwd: resolve(cwd), nativeSessionId }), { encoding: 'utf8', mode: 0o600 });
    }, readySession: async (child, id) => {
      if (dependencies.configure) return; // Explicit injected offline setup.
      await waitNativeMcpReady(logs, child, id, value => evidence(value, operationRoot), 20_000, disabledServerCount);
      if (pluginStore) {
        const catalogue = await verifyNativePluginState(logs, child, id, cwd, pluginStore, pluginsOff, value => evidence(value, operationRoot));
        const isolation = assertOfficialLaunchIsolation(pluginStore, pluginPreload!, catalogue);
        evidence({ event: 'official-plugin-launch-guard', sessionId: id, ...isolation }, operationRoot);
        if (isolation.warning) warnings.push(isolation.warning);
        const trust = assertEmptyWorkspaceTrust(ownHome, dataRoot);
        evidence({ event: 'workspace-hook-trust-guard', sessionId: id, records: trust.records, present: trust.present }, operationRoot);
      }
    }, launch: { executable: paths.executable, args: [...(pluginPreload ? ['--require', pluginPreload] : []), paths.script, 'app-server', '--stdio', '--surface', 'desktop'], cwd,
      onMissingFiles: dependencies.paths ? undefined : () => { resolveZCode(true); },
      env: launchEnv }, configure: async child => {
      children.add(child);
      // Stdio close alone does not establish whole-group settlement.
      void child.closed.then(() => child.close()).then(remaining => { if (!remaining) children.delete(child); }, () => {});
      evidence({ event: 'native-startup', pid: child.child.pid, bridgePid: process.pid, service, generation: child.generation, surface: 'desktop', envNames: Object.keys(own) }, operationRoot);
      if (dependencies.configure) { await dependencies.configure(child); return; }
      if (!Object.values(paths).every(existsSync)) { resolveZCode(true); throw new MissingExecutableError('ZCode files disappeared during startup. The installation path was refreshed; retry the turn.'); }
      await child.request('runtime/capabilities', {});
      evidence({ event: 'native-process-identity', pid: child.child.pid, nativePid: child.nativePid,
        bridgePid: process.pid, service, generation: child.generation }, operationRoot);
      let revision: string | null = null;
      const end = Date.now() + 20_000;
      while (!revision && Date.now() < end) {
        for (const file of readdirSync(logs).filter(f => f.endsWith('.jsonl'))) for (const line of readFileSync(join(logs, file), 'utf8').split('\n').filter(Boolean)) {
          try {
            const context = record(record(JSON.parse(line)).context);
            if (typeof context.configRevision === 'string' && typeof context.providerCount === 'number') {
              const parts: unknown = JSON.parse(context.configRevision);
              if (Array.isArray(parts) && typeof parts[0] === 'string') revision = parts[0];
            }
          } catch { /* Partial line is not evidence. */ }
        }
        if (!revision) await delay(50);
      }
      if (!revision) throw new Error('Runtime builtin revision unavailable; no entitlement overlay');
      builtinRevision = revision;
      await child.request('provider/updateAccountConfig', sessionAuth.overlay(`bb-${randomUUID()}`, revision));
      evidence({ event: 'overlay-ack-only', runtimeBuiltinRevision: revision }, operationRoot);
    } };
  }
  const services: BridgeServices = {
    compatibility,
    compatibilityWarning() {
      const value = compatibility();
      const key = JSON.stringify('tuple' in value ? { bb: value.tuple.bb, sdk: value.tuple.installedSdk,
        declaredSdk: value.tuple.declaredSdk, desktop: value.tuple.desktop, cli: value.tuple.cli } : value);
      return claimNotice(root, 'last-version-combination', key) ? value.message : null;
    },
    claimDiagnostic: (threadId, code) => claimNotice(root, diagnosticNoticeName(threadId, code), code),
    observe: evidence,
    prepare,
    async health(mode = 'cli') {
      const d = detect(), paths = getPaths(); let status: 'not_installed' | 'ready' | 'unauthenticated' | 'unknown' = !d.installed ? 'not_installed' : 'ready';
      let message = status === 'ready' ? `Ready. ZCode: ${paths.script.replace('/Contents/Resources/glm/zcode.cjs', '')}.` : resolveZCode().bundle ? 'ZCode Desktop installation incomplete: repair or reinstall ZCode Desktop.' : resolveZCode().message;
      if (status === 'ready') try { selectedAuth(mode).read('health'); } catch (e) {
        status = e instanceof AuthError && ['unauthenticated', 'missing-key'].includes(e.kind) ? 'unauthenticated' : 'unknown';
        message = mode === 'coding-plan-key' ? 'Explicit Coding Plan key unavailable or unreadable in protected plugin settings; no CLI fallback.' : status === 'unauthenticated' ? signInHint(paths) : e instanceof AuthError ? e.message : 'CLI store unreadable or unsupported; no fallback.';
      }
      const context = d.installed ? compatibility().message : null;
      if (context) message += ' ' + context;
      return providerHealthResultSchema.parse({ supported: true, health: { accountEmail: null, canInstall: false, canUpdate: false, installedVersion: d.version, loginCommand: mode === 'cli' && d.installed ? loginCommand(paths) : null, minimumSupportedVersion: null, planLabel: mode === 'cli' ? 'CLI Coding Plan' : 'Explicit Coding Plan key / gateway', status, statusMessage: message } });
    },
    async installation() {
      const d = detect(), paths = getPaths();
      return providerInstallationStatusSchema.parse({ currentVersion: d.version, executableName: 'zcode', executablePath: d.installed ? paths.script : null, installAction: null, installSource: d.installed ? 'external' : 'notInstalled', installed: d.installed, latestVersion: null, minimumSupportedVersion: null, needsUpdate: false, npmGlobalPackageVersion: null, npmPackageName: null, versionUnsupported: false });
    },
    async models(_cwd, mode = 'cli', refresh = 0) {
      if (stopped) throw new Error('Native services closed');
      // Unknown versions run; the actual catalogue/protocol still validates.
      const d = detect();
      if (!d.installed) throw new MissingExecutableError(resolveZCode().message);
      // Authentication is fresh even for an in-memory public catalogue hit.
      selectedAuth(mode).read('catalogue-ready');
      const scope = persistentCatalogue ? cacheScope(d, mode, refresh) : JSON.stringify({ mode, refresh, credentials: fileIdentity(mode === 'cli' ? [auth.path] : explicitKeyPath ? [explicitKeyPath] : []) });
      if (catalogueScope !== scope) { catalogueEpoch++; catalogue = undefined; loading = undefined; catalogueScope = scope; }
      if (catalogue) { evidence({ event: 'catalogue-cache-hit', epoch: catalogueEpoch }); return structuredClone(catalogue); }
      if (!loading) {
        const epoch = catalogueEpoch, loadRoot = root;
        const promise = (!persistentCatalogue ? loadCatalogue(loadRoot, mode) : cachedCatalogue(loadRoot, scope, epoch, mode, refresh)).then(value => {
          if (stopped || epoch !== catalogueEpoch) throw new Error('Catalogue root changed or services closed; retry on current root');
          catalogue = value;
          return value;
        }).finally(() => { if (loading?.epoch === epoch) loading = undefined; });
        loading = { epoch, promise };
        catalogueLoads.add(promise);
        void promise.then(() => catalogueLoads.delete(promise), () => catalogueLoads.delete(promise));
      }
      return structuredClone(await loading.promise);
    },
    async validateSelection(model, reasoning, mode = 'cli', refresh = 0) {
      const available = record(await services.models(undefined, mode, refresh)).models as ReturnType<typeof mapNativeModels>;
      const selected = model ? available.find(m => m.model === model) : available.find(m => m.isDefault);
      const effort = reasoning || selected?.defaultReasoningEffort;
      if (!selected || !effort || !selected.supportedReasoningEfforts.some(e => e.reasoningEffort === effort)) throw new Error('Selected model/reasoning unavailable; models with a default reasoning level unsupported by bb SDK cannot be used. No fallback');
      return { model: selected.model, reasoning: effort };
    },
  };
  async function loadCatalogue(loadRoot: string, mode: AuthMode = 'cli'): Promise<Catalogue> {
      const cwd = join(loadRoot, 'catalogue-scratch'); mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const setup = await prepare(cwd, undefined, undefined, true, mode);
      const launch = setup.launch;
      const child = new NativeProcess(launch, 1, null, m => {
        if (m.method === 'session/requestRuntimePreferences') child.write({ jsonrpc: '2.0', id: m.id, result: runtimePreferences });
        else if (m.method === 'interaction/requestProviderRuntimeHeaders') child.write({ jsonrpc: '2.0', id: m.id, result: { headersApplied: false, errorMessage: 'Catalogue service cannot infer' } });
      }, () => {});
      let primary: unknown;
      try {
        await setup.configure(child);
        const snapshot = record(await child.request('session/create', { workspace: { workspacePath: cwd, workspaceKey: cwd }, mode: 'yolo', persistence: 'deferred', titleGenerationEnabled: false }));
        const model = record(record(snapshot.settings).model);
        const models = mapNativeModels(model.available, model.current);
        evidence({ event: 'actual-catalogue', models, nativeDefault: model.current, source: 'session/create' }, loadRoot); return { models };
      } catch (e) { primary = e; throw e; }
      finally {
        try {
          const remaining = await child.close(); evidence({ event: 'catalogue-cleanup', pid: child.child.pid, remaining, diagnostics: child.cleanupDiagnostics }, loadRoot);
          if (remaining) throw new Error('Catalogue process group remains');
        } catch (cleanup) {
          evidence({ event: 'catalogue-cleanup-error', primaryError: primary !== undefined, diagnostics: child.cleanupDiagnostics }, loadRoot);
          if (primary !== undefined) throw new AggregateError([primary, cleanup], 'Catalogue read and cleanup failed');
          throw cleanup;
        }
      }
  }
  return { services, setSecretRoot(path: string) { explicitKeyPath = join(resolve(path), 'backupKey'); }, setRoot(path: string) { const next = resolve(path); configureZCodeLocation(next, evidence); if (next !== root) { root = next; catalogueEpoch++; catalogue = undefined; loading = undefined; }
    // Maintenance starts only after bb supplies this installation's owned data root.
    scheduleDataMaintenance(root);
    maintenanceTimer ??= setInterval(() => scheduleDataMaintenance(root), 24 * 60 * 60 * 1000);
    maintenanceTimer.unref();
  }, root: () => root, metadata: () => ({ reads: auth.reads, freshReadGeneration: auth.generation }),
    async close() { clearInterval(maintenanceTimer); stopped = true; catalogueEpoch++; catalogue = undefined; loading = undefined; await Promise.allSettled([...catalogueLoads]); const results = await Promise.all([...children].map(child => child.close())); if (results.some(Boolean)) throw new Error('Owned service process remains'); } };
}
