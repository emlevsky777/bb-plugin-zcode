import { reasoningLevelValues } from '@get-bb/plugin-sdk/provider-bridge';
import type { BbPluginApi, PluginProviderDeclaration } from '@get-bb/plugin-sdk';
import { compactionItemSchema } from './compaction.ts';
import { signInHint } from './applications.ts';
import { join } from 'node:path';
import { localProblemReport } from './problem-report.ts';
import { reportCli } from './report-cli.ts';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { authMode } from './auth.ts';
import { registerUsageSource } from './usage-source.ts';
export default async function plugin(bb: BbPluginApi): Promise<void> {
  bb.agents?.configure(() => ({ tools: [], skills: ['zcode-provider'] }));
  const settings = bb.settings.define({
    checkStartPromotions: { type: 'boolean', default: false, label: 'Check for Start Plan promotions',
      description: 'Reads promotion messages in English to notify you about Start Plan claim offers in ZCode Desktop. Claim eligibility is checked in Desktop. When off, no promotion requests or notices are made; quota already claimed is still detected.' },
    memoryEnabled: { type: 'boolean', default: true, label: 'ZCode memory fallback',
      description: 'Used when Desktop has no readable memory preference. Desktop memory takes priority. Changes apply on the next ordinary turn; steering keeps active settings.' },
    subagentsDisabled: { type: 'boolean', default: false, label: 'Disable provider subagents',
      description: 'Disable native ZCode agents. Changes apply on the next ordinary turn; steering keeps the active turn settings.' },
    authMode: { type: 'select', label: 'ZCode sign-in source', options: ['desktop', 'coding-plan-key'], default: 'desktop',
      description: 'desktop uses your existing Desktop sign-in. coding-plan-key uses the backup key for the Coding Plan gateway.' },
    backupKey: { type: 'string', label: 'Backup Coding Plan key', secret: true,
      description: 'Used only with coding-plan-key on this Mac. bb stores this secret in a protected file.' },
  });
  // Health in bb 0.48.1 has neither per-command settings nor contributed env.
  // Project auth source and the promotion preference into this plugin's data, never native
  // credentials/config. Ordinary input and steering remain per-command.
  if (bb.server?.experimental_dataDir && bb.pluginId) {
    const root = join(bb.server.experimental_dataDir, 'plugins', bb.pluginId, 'bridge-data/zcode');
    const projectSelection = (values: Record<string, unknown>) => {
      const selected = { authMode: authMode(values.authMode), checkStartPromotions: values.checkStartPromotions === true };
      mkdirSync(root, { recursive: true });
      const file = join(root, 'account-selection.json'), temp = file + '.' + randomUUID() + '.tmp';
      writeFileSync(temp, JSON.stringify(selected), 'utf8'); renameSync(temp, file);
    };
    projectSelection(await settings.get());
    settings.onChange(projectSelection);
  }
  const provider = { id: 'zcode-provider', displayName: 'ZCode Provider', icon: './assets/zcode.svg',
    experimental_resolvesNativeRoots: true,
    deriveProviderOptions(context) { return { authMode: String(context.settings.authMode ?? 'desktop'), providerSubagentsEnabled: context.settings.subagentsDisabled !== true, memoryEnabled: context.settings.memoryEnabled !== false }; },
    strings: { signInHint: signInHint(),
      expiredHint: 'Start Plan access has expired. Check promotions in ZCode Desktop; Coding Plan is separate.', installUrl: 'https://zcode.z.ai' },
    models: { scope: 'host' }, maintenance: { health: true, installation: true, usage: true },
    capabilities: { supportsServiceTier: false, supportsNativeUserQuestion: false, fork: 'none',
      supportsManualCompaction: true, supportsThreadArchive: false, supportsThreadRename: false,
      permissionModes: ['full'], reasoningLevels: reasoningLevelValues },
    reasoningLevels: reasoningLevelValues.map(id => ({ id, label: id })),
    composerActions: [],
    extensionKinds: { compaction: { item: compactionItemSchema } },
  } satisfies PluginProviderDeclaration;
  bb.providers.register(provider);
  if (bb.rpc && bb.sdk) registerUsageSource(bb, provider.id, async () => authMode((await settings.get()).authMode));
  // bb 0.48.1 maintenance uses launch options, without deriveProviderOptions.
  // Its contributed-env fingerprint refreshes the host catalogue when these
  // non-secret selections change. Ordinary turns still use per-command options.
  bb.providers.experimental_contributeEnv?.(provider.id, async () => {
    const values = await settings.get();
    return [
      { name: 'BB_ZCODE_AUTH_MODE', value: String(values.authMode ?? 'desktop'), reason: 'Selected ZCode sign-in source for maintenance' },
      { name: 'BB_ZCODE_CHECK_START_PROMOTIONS', value: String(values.checkStartPromotions === true), reason: 'Refresh catalogue when promotion discovery preference changes' },
    ];
  });
  bb.cli?.register(reportCli(async () => {
        const root = join(bb.server.experimental_dataDir, 'plugins', bb.pluginId, 'bridge-data/zcode');
        return { local: localProblemReport(root), settings: await settings.get() };
    }));
}
