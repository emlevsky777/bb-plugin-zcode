import { assertHostNode } from './node-version.ts';
import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { resolveNativeRootsCached } from './native-roots.ts';
import { experimental_defineProviderBridge, createBridgeIo } from '@get-bb/plugin-sdk/provider-bridge';
import { createZCodeBridge } from './bridge.ts';
import { createNativeServices } from './runtime.ts';
import { join, dirname, basename } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { pluginRootsContract } from './plugin-roots-config.ts';
import { clearRootsCache } from './native-roots.ts';
import { configureZCodeLocation } from './applications.ts';
export { createZCodeBridge } from './bridge.ts';

assertHostNode();
// The combined contract retains the native-root SDK validators and adds only
// our own setting synchronization; core still calls resolveNativeRoots.
export const experimental_host = experimental_defineHostEntry({ contract: pluginRootsContract,
  handlers: {
    setPluginsEnabled(input, context) {
      const { enabled } = input as { enabled: boolean }, dir = context.experimental_paths.dataDir;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, 'plugins-enabled.json'), temp = file + '.tmp';
      writeFileSync(temp, JSON.stringify({ enabled }) + '\n', { encoding: 'utf8', mode: 0o600 }); renameSync(temp, file);
      clearRootsCache(); return { enabled };
    },
    resolveNativeRoots(input, context) {
      configureZCodeLocation(join(context.experimental_paths.dataDir, 'zcode'));
      let enabled = false;
      try { enabled = JSON.parse(readFileSync(join(context.experimental_paths.dataDir, 'plugins-enabled.json'), 'utf8')).enabled === true; }
      catch { /* Optional menu layer fails closed. */ }
      return resolveNativeRootsCached((input as { cwd: string | null }).cwd,
        join(context.experimental_paths.dataDir, 'native-roots'), context.signal, undefined, enabled);
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
