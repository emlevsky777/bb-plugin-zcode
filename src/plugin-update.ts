import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

type UpdateCache = { installation: string; checkedAt: number; candidate: string | null };
const hour = 60 * 60_000;

function installationIdentity(): string {
  const file = new URL(import.meta.url);
  file.search = ''; file.hash = '';
  // A Git cache path changes even for a same-version commit with identical
  // code; the bundle hash also identifies local builds at an unchanged path.
  return createHash('sha256').update(file.href).update(readFileSync(file)).digest('hex');
}

// BB owns the upstream check. Read its saved result only for a new thread,
// sharing successful and failed attempts across all hosts of this installation.
export function createPluginUpdateLookup(bb: BbPluginApi, now = Date.now, identify = installationIdentity) {
  let cached: UpdateCache | undefined;
  let pending: Promise<string | null> | undefined;
  let identity: string | undefined;
  return (): Promise<string | null> => {
    if (pending) return pending;
    const load = async () => {
      identity ??= identify();
      const key = 'plugin-update-result';
      if (!cached) {
        try {
          const saved = await bb.storage.kv.get<UpdateCache>(key);
          if (saved && typeof saved.installation === 'string' && Number.isFinite(saved.checkedAt) && (saved.candidate === null || typeof saved.candidate === 'string')) cached = saved;
        } catch { /* The optional cache can be unavailable. */ }
      }
      if (cached && cached.installation !== identity) {
        // Applying an update invalidates its old offer, but does not require
        // an extra read within the shared hour. The next interval can refresh.
        cached = { installation: identity, checkedAt: cached.checkedAt, candidate: null };
        try { await bb.storage.kv.set(key, cached); } catch { /* Optional persistence. */ }
      }
      const at = now();
      if (cached && at - cached.checkedAt < hour) return cached.candidate;
      const entry = { installation: identity, checkedAt: at, candidate: cached?.candidate ?? null };
      cached = entry;
      // Record the attempt before reading, also across plugin reloads.
      try { await bb.storage.kv.set(key, entry); } catch { /* Memory still shares the attempt. */ }
      try {
        const entries = await bb.sdk.plugins.listUpdateResults({ signal: AbortSignal.timeout(2000) });
        entry.candidate = entries.find(value => value.id === bb.pluginId && value.outcome === 'update-available')?.candidate?.version ?? null;
      } catch { /* Preserve the last known result; retry on demand after an hour. */ }
      try { await bb.storage.kv.set(key, entry); } catch { /* Optional persistence. */ }
      return entry.candidate;
    };
    pending = load().finally(() => { pending = undefined; });
    return pending;
  };
}
