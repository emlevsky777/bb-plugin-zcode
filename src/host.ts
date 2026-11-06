import { assertHostNode } from './node-version.ts';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { resolveNativeRootsCached } from './native-roots.ts';
import { experimental_defineProviderBridge, createBridgeIo } from '@get-bb/plugin-sdk/provider-bridge';
import { createZCodeBridge } from './bridge.ts';
import { createNativeServices } from './runtime.ts';
import { join, dirname, basename } from 'node:path';
import { experimental_nativeRootsHostContract } from '@get-bb/plugin-sdk/host';
import type { PluginRpcContract } from '@get-bb/plugin-sdk';
import { configureZCodeLocation } from './applications.ts';
import { codingHostContract, usageMeasurement } from './usage-source.ts';
import { collectCodingUsage } from './coding-usage.ts';
import { discovery } from './runtime.ts';
import { appendFileSync, mkdirSync } from 'node:fs';
import { observerEnvironment } from './observer.ts';
export { createZCodeBridge } from './bridge.ts';

assertHostNode();
// Keep the native-root SDK validators; settings travel per command.
// SDK .79's exported Zod contract and host StandardSchema failure result
// declarations differ; retain the original runtime validators unchanged.
export const experimental_host = experimental_defineHostEntry({ contract: { ...experimental_nativeRootsHostContract, ...codingHostContract } as unknown as PluginRpcContract,
  handlers: {
    async codingUsage(input, context) {
      const root = join(context.experimental_paths.dataDir, 'coding-usage');
      const pluginRoot = dirname(context.experimental_paths.dataDir);
      // Same host-owned plugin layout as the existing bridge secret lookup.
      const keyPath = basename(context.experimental_paths.dataDir) === 'host-data'
        ? join(pluginRoot, 'secrets', 'backupKey') : undefined;
      const value = await collectCodingUsage({ root, mode: (input as { mode: string }).mode,
        ...(keyPath ? { keyPath } : {}), version: discovery().tuple?.desktop ?? 'unknown',
        env: { ...process.env, ...observerEnvironment(join(pluginRoot, 'bridge-data/zcode')) },
        beforeRead(endpoint) {
          mkdirSync(root, { recursive: true });
          appendFileSync(join(root, 'read-ledger.ndjson'), JSON.stringify({ at: new Date().toISOString(), endpoint, method: 'GET' }) + '\n');
        } });
      return usageMeasurement(value.usage as unknown as Record<string, unknown>, value.observedAt);
    },
    resolveNativeRoots(input, context) {
      configureZCodeLocation(join(context.experimental_paths.dataDir, 'zcode'));
      return resolveNativeRootsCached((input as { cwd: string | null }).cwd,
        join(context.experimental_paths.dataDir, 'native-roots'), context.signal);
    }
  } });
export default experimental_host;
const runtime = createNativeServices();
const io = createBridgeIo();
const bridge = createZCodeBridge(runtime.services, message => io.send(message));
export const handleLine = bridge.handleLine;
let closing: Promise<void> | undefined;
const close = () => {
  if (closing) return;
  const deadline = setTimeout(() => {
    process.stderr.write('ZCode shutdown deadline exceeded; cleanup unconfirmed\n');
    process.exit(1);
  }, 20_000);
  closing = bridge.close().finally(() => runtime.close()).then(() => new Promise<void>((done, reject) => {
    // A callback on the final write drains queued protocol bytes while BB reads.
    const timer = setTimeout(() => reject(new Error('Shutdown output flush timed out')), 1000);
    process.stdout.write('', error => { clearTimeout(timer); if (error) reject(error); else done(); });
  }));
  void closing.then(() => {
    clearTimeout(deadline); process.exit(Number(process.exitCode ?? 0));
  }, () => {
    // Fixed diagnostic only; no raw native error or credential-bearing payload.
    clearTimeout(deadline); process.stderr.write('ZCode owned cleanup unresolved\n'); process.exit(1);
  });
};
export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine, start(context) {
    bridge.setPluginId(context.pluginId);
    runtime.setRoot(join(context.dataDir, 'zcode'));
    // bb0.45 native local plugin secret store; never a path from turn input.
    if (basename(context.dataDir) === 'bridge-data' && basename(dirname(context.dataDir)) === context.pluginId)
      runtime.setSecretRoot(join(dirname(context.dataDir), 'secrets'));
  },
  onClose: close, onSigterm: close, onSigint: close,
});
