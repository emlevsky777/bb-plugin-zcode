// Host-wide demand sharing for bb's separate catalogue/thread/Usage bridges.
// Public normalized state only; never credentials or remote error bodies.
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
type Snapshot = { scope: string; at: number; until: number; value?: unknown; failed?: boolean };
const pending = new Map<string, Promise<unknown>>();
const file = (root: string, name: string) => join(root, `discovery-${name}.json`);
export const discoveryScope = (scope: string) => createHash('sha256').update(scope).digest('hex');
function snapshot(root: string, name: string, scope: string): Snapshot | undefined {
  try {
    const s = JSON.parse(readFileSync(file(root, name), 'utf8'));
    if (s.scope === scope && Number.isFinite(s.at) && Number.isFinite(s.until) && s.at <= Date.now()) return s;
  } catch { /* Missing or invalid optional public snapshot. */ }
}
export function peekDiscovery<T>(root: string, name: string, scope: string, decode: (v: unknown) => T): T | undefined {
  const s = snapshot(root, name, scope);
  if (s && !s.failed && Date.now() < s.until) try { return decode(s.value); } catch { /* Invalid cache. */ }
}
export async function readDiscovery<T>(root: string, name: string, scope: string, ttl: number,
  load: () => Promise<T>, decode: (v: unknown) => T, validUntil: (v: T) => number = () => Infinity,
  isCurrent: () => boolean = () => true, failureTtl = 60_000): Promise<T> {
  const path = file(root, name), key = JSON.stringify([path, scope]);
  if (pending.has(key)) return pending.get(key) as Promise<T>;
  const task = (async () => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const hit = () => {
      const s = snapshot(root, name, scope);
      if (!s || Date.now() >= s.until) return;
      if (s.failed) throw Error('Start discovery unavailable; check ZCode Desktop and retry refresh later.');
      const value = decode(s.value);
      // Expiry revokes an old grant locally; a read is still bounded by the
      // access attempt gate. Never authorize a model using an expired snapshot.
      if (validUntil(value) <= Date.now()) throw Error('Start discovery snapshot expired; retry refresh after the access interval.');
      return { value };
    };
    const cached = hit(); if (cached) return cached.value;
    const lock = path + '.pending', deadline = Date.now() + 20_000;
    for (;;) {
      try { writeFileSync(lock, '', { flag: 'wx', mode: 0o600 }); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // Reclaim only an abandoned transport lock, beyond the 15s HTTP timeout.
        try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { unlinkSync(lock); continue; } } catch { continue; }
        if (Date.now() >= deadline) throw Error('Start discovery still pending; retry an independent operation.');
        await delay(25);
        const shared = hit(); if (shared) return shared.value;
      }
    }
    try {
      const shared = hit(); if (shared) return shared.value;
      const publish = (s: Snapshot) => {
        const temp = path + '.' + randomUUID() + '.tmp';
        try { writeFileSync(temp, JSON.stringify(s), { encoding: 'utf8', mode: 0o600 }); renameSync(temp, path); }
        finally { try { unlinkSync(temp); } catch { /* Already published. */ } }
      };
      try {
        const value = decode(await load()), at = Date.now();
        if (!isCurrent()) throw Error('Start discovery scope changed; retry an independent operation.');
        publish({ scope, at, until: at + ttl, value }); return value;
      } catch (error) {
        const at = Date.now(); if (isCurrent()) publish({ scope, at, until: at + failureTtl, failed: true }); throw error;
      }
    } finally { try { unlinkSync(lock); } catch { /* Optional lock cleanup. */ } }
  })().finally(() => { if (pending.get(key) === task) pending.delete(key); });
  pending.set(key, task); return task;
}
