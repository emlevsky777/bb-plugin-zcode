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
export { createZCodeBridge } from './bridge.ts';

assertHostNode();
// Keep the native-root SDK validators; settings travel per command.
// SDK .79's exported Zod contract and host StandardSchema failure result
// declarations differ; retain the original runtime validators unchanged.
export const experimental_host = experimental_defineHostEntry({ contract: experimental_nativeRootsHostContract as unknown as PluginRpcContract,
  handlers: {
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
