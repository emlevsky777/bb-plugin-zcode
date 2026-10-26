import { reasoningLevelValues } from '@get-bb/plugin-sdk/provider-bridge';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { compactionItemSchema } from './compaction.ts';
import { signInHint } from './applications.ts';
import { join } from 'node:path';
import { localProblemReport } from './problem-report.ts';
import { reportCli } from './report-cli.ts';
export default async function plugin(bb: BbPluginApi): Promise<void> {
  bb.agents?.configure(() => ({ tools: [], skills: ['zcode-provider'] }));
  const settings = bb.settings.define({
    memoryEnabled: { type: 'boolean', default: true, label: 'ZCode memory fallback',
      description: 'Used when Desktop has no readable memory preference. Desktop memory takes priority. Changes apply on the next ordinary turn; steering keeps active settings.' },
    subagentsDisabled: { type: 'boolean', default: false, label: 'Disable provider subagents',
      description: 'Disable native ZCode agents. Changes apply on the next ordinary turn; steering keeps the active turn settings.' },
    authMode: { type: 'select', label: 'ZCode sign-in source', options: ['cli', 'coding-plan-key'], default: 'cli',
      description: 'cli uses your existing Desktop sign-in. coding-plan-key uses the backup key for the Coding Plan gateway.' },
    backupKey: { type: 'string', label: 'Backup Coding Plan key', secret: true,
      description: 'Used only with coding-plan-key on this Mac. bb stores this secret in a protected file.' },
  });
  bb.providers.register({ id: 'zcode', displayName: 'ZCode', icon: './assets/zcode.svg',
    experimental_resolvesNativeRoots: true,
    deriveProviderOptions(context) { return { authMode: String(context.settings.authMode ?? 'cli'), catalogueRefresh: Number(context.settings.catalogueRefresh ?? 0), providerSubagentsEnabled: context.settings.subagentsDisabled !== true, memoryEnabled: context.settings.memoryEnabled !== false }; },
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
  bb.cli?.register(reportCli(async () => {
        const root = join(bb.server.experimental_dataDir, 'plugins', bb.pluginId, 'bridge-data/zcode');
        return { local: localProblemReport(root), settings: await settings.get() };
    }));
}
