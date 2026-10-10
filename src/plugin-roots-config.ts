import type { PluginRpcContract } from '@get-bb/plugin-sdk';
import { experimental_nativeRootsHostContract } from '@get-bb/plugin-sdk/host';
const flagSchema = { '~standard': { version: 1 as const, vendor: 'zcode', validate(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof (value as { enabled?: unknown }).enabled !== 'boolean')
    return { issues: [{ message: 'Expected enabled boolean' }] };
  return { value: value as { enabled: boolean } };
} } };
export const pluginRootsContract = { ...experimental_nativeRootsHostContract,
  setPluginsEnabled: { input: flagSchema, output: flagSchema } } as unknown as PluginRpcContract;
