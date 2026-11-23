import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFileIdentityCache } from './compatibility.ts';
import { zcodeEndpointOrigin } from './start-offer.ts';

// Desktop-surface app-server only reads CONFIG_FILE, ignoring BUNDLED_CONFIG_FILE.
// Keep the shared Desktop path as an input identity, without repairing it.
export function desktopBuiltinPath(bundled: string, version: string | null,
  env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (!version) return bundled;
  const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}`;
  const endpoint = 'endpoint-' + createHash('sha256').update(zcodeEndpointOrigin(env)).digest('hex').slice(0, 32);
  return join(home, '.zcode/v2/runtime/provider', platform, version, endpoint, 'zcode-builtin.json');
}
let candidateCache: { paths: string; read: () => string } | undefined;
export function desktopBuiltinCandidate(bundled: string, active: string): string {
  const paths = JSON.stringify([bundled, active]);
  if (candidateCache?.paths !== paths) candidateCache = { paths, read: createFileIdentityCache([bundled, active], () => {
    const revision = (file: string): number | null => {
      try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        return value?.schemaVersion === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : null;
      } catch { return null; }
    };
    const activeRevision = revision(active), bundledRevision = revision(bundled);
    // This is only a candidate: the actual app-server validates its full schema.
    return activeRevision !== null && (bundledRevision === null || activeRevision > bundledRevision) ? active : bundled;
  }) };
  return candidateCache.read();
}
export function desktopBuiltinEnvironment(bundled: string, version: string | null,
  env: NodeJS.ProcessEnv = process.env, home = homedir()): NodeJS.ProcessEnv {
  return {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: desktopBuiltinPath(bundled, version, env, home),
    ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: bundled,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim() || join(home, '.zcode/v2/provider_config.json'),
  };
}
