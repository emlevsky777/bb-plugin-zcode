import { reasoningLevelValues } from '@get-bb/plugin-sdk/provider-bridge';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { pluginRootsContract } from './plugin-roots-config.ts';
import { compactionItemSchema } from './compaction.ts';
import { signInHint } from './applications.ts';
import { join } from 'node:path';
import { localProblemReport, formatProblemReport } from './problem-report.ts';
export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    subagentsDisabled: { type: 'boolean', default: false, label: 'Disable provider subagents',
      description: 'Disable native ZCode agents. Changes apply on the next ordinary turn; steering keeps the active turn settings.' },
    authMode: { type: 'select', label: 'ZCode sign-in source', options: ['cli', 'coding-plan-key'], default: 'cli',
      description: 'cli reads your existing ZCode login. coding-plan-key uses the backup key for the Coding Plan gateway.' },
    backupKey: { type: 'string', label: 'Backup Coding Plan key', secret: true,
      description: 'Used only with coding-plan-key on this Mac. bb stores this secret in a protected file.' },
    useZCodePlugins: { type: 'boolean', default: false, label: 'Use personal and project ZCode plugins and hooks',
      description: 'Enables automatic hooks, including project hooks. Running Desktop and bb together may run a hook twice. When off, standalone skills, commands and official plugins remain available.' },
    useUserMcp: { type: 'boolean', default: false, label: 'User MCP (not available yet)',
      description: 'User MCP servers are currently disabled. Support will be added separately.' },
  });
  const register = (values: { authMode: string; useZCodePlugins?: boolean }) => bb.providers.register({ id: 'zcode', displayName: 'ZCode', icon: './assets/zcode.svg',
    experimental_bridgeOptions: { authMode: values.authMode, catalogueRefresh: 0, useZCodePlugins: values.useZCodePlugins === true, useUserMcp: false },
    experimental_resolvesNativeRoots: true,
    deriveProviderOptions(context) { return { authMode: String(context.settings.authMode ?? 'cli'), catalogueRefresh: Number(context.settings.catalogueRefresh ?? 0), useZCodePlugins: context.settings.useZCodePlugins === true, useUserMcp: false, providerSubagentsEnabled: context.settings.subagentsDisabled !== true }; },
    strings: { signInHint: signInHint(),
      expiredHint: `ZCode login expired. ${signInHint()}`, installUrl: 'https://zcode.z.ai' },
    models: { scope: 'host' }, maintenance: { health: true, installation: true, usage: false },
    capabilities: { supportsServiceTier: false, supportsNativeUserQuestion: false, fork: 'none',
      supportsManualCompaction: true, supportsThreadArchive: false, supportsThreadRename: false,
      permissionModes: ['full'], reasoningLevels: reasoningLevelValues },
    reasoningLevels: reasoningLevelValues.map(id => ({ id, label: id })),
    composerActions: [],
    extensionKinds: { compaction: { item: compactionItemSchema } },
  });
  let values = await settings.get();
  bb.cli?.register({ name: 'zcode-report', summary: 'Print a safe local ZCode problem report',
    async run(argv) {
      if (argv.length) return { exitCode: 1, stderr: 'Usage: bb zcode-report\n' };
      try {
        const root = join(bb.server.experimental_dataDir, 'plugins', bb.pluginId, 'bridge-data/zcode');
        return { exitCode: 0, stdout: formatProblemReport(localProblemReport(root), await settings.get()) };
      } catch { return { exitCode: 1, stderr: 'ZCode report unavailable; check plugin status.\n' }; }
    } });
  const host = bb.hosts?.experimental_client({ contract: pluginRootsContract });
  const sync = async () => {
    if (!host) return; // Minimal offline registration fixtures have no host.
    try {
      const hostId = (await bb.sdk.system.config()).primaryHostId;
      if (!hostId) throw Error('Local host missing');
      await host.call('setPluginsEnabled', { enabled: values.useZCodePlugins === true }, { hostId });
    } catch { bb.log.warn('ZCode plugin menu setting could not be synchronized on the local host'); }
  };
  let registration = register(values);
  // Host RPC is unavailable while bb runs the plugin factory. The service
  // starts after registration; the host persists this flag across worker exits.
  if (host) bb.background.service('native-plugin-menu-setting', { async start(signal) {
    await sync();
    if (!signal.aborted) await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }));
  } });
  settings.onChange(async next => {
    values = next; await sync();
    registration?.dispose?.(); registration = register(values);
  });
}
