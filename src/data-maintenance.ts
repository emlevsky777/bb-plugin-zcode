import { promises as fs } from 'node:fs';
import { join } from 'node:path';
const day = 24 * 60 * 60 * 1000;
export const dataLimits = { journal: 32 * 1024 * 1024, generations: 256 * 1024 * 1024, previous: 2, interval: day };
const running = new Map<string, Promise<unknown>>();
async function regular(path: string) {
  try { const s = await fs.lstat(path); return s.isFile() ? s : undefined; } catch { return; }
}
async function directory(path: string) {
  try { return (await fs.lstat(path)).isDirectory(); } catch { return false; }
}
async function names(path: string) { return await directory(path) ? fs.readdir(path) : []; }
async function rotate(path: string, limit: number) {
  const info = await regular(path);
  if (!info || info.size <= limit) return;
  if (await regular(path + '.2')) await fs.unlink(path + '.2');
  if (await regular(path + '.1')) await fs.rename(path + '.1', path + '.2');
  await fs.rename(path, path + '.1');
}

// Targeted journal inventory only; never traverse session HOME, db, settings or host-data.
export async function maintainData(root: string, now = Date.now(), limits = dataLimits) {
  if (!await directory(root)) return { checked: false, removed: [] as string[] };
  const lock = join(root, 'data-maintenance.lock');
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch {
    const stale = await regular(lock);
    if (!stale || Date.now() - stale.mtimeMs <= day) return { checked: false, removed: [] as string[] };
    await fs.unlink(lock);
    try { handle = await fs.open(lock, 'wx', 0o600); } catch { return { checked: false, removed: [] as string[] }; }
  }
  try { return await maintainOwnedData(root, now, limits); }
  finally { await handle.close(); await fs.unlink(lock).catch(() => {}); }
}
async function maintainOwnedData(root: string, now: number, limits: typeof dataLimits) {
  if (!await directory(root)) return { checked: false, removed: [] as string[] };
  const marker = join(root, 'data-maintenance.json');
  let last = 0, debugRemoved = false;
  try { const value = JSON.parse(await fs.readFile(marker, 'utf8')); last = value.at; debugRemoved = value.debugRemoved === true; } catch { /* First run. */ }
  if (Number.isFinite(last) && now - last < limits.interval) return { checked: false, removed: [] as string[] };
  const removed: string[] = [];
  // Persist frequency claim first; failure doesn't create a turn-time retry loop.
  await fs.writeFile(marker, JSON.stringify({ at: now, debugRemoved }), { mode: 0o600 });
  for (const name of ['service-evidence.ndjson', 'auth-metadata.ndjson']) await rotate(join(root, name), limits.journal);
  if (!debugRemoved) {
    const debug = join(root, 'data/cli/debug');
    // Reject symlink parents as well as symlink files.
    if (await directory(join(root, 'data')) && await directory(join(root, 'data/cli')))
      for (const name of await names(debug)) if (/^model-io-[A-Za-z0-9_-]+\.jsonl$/.test(name) && await regular(join(debug, name))) {
        await fs.unlink(join(debug, name)); removed.push('data/cli/debug/' + name);
      }
    debugRemoved = true;
  }
  const generations = join(root, 'generations');
  const journals: { path: string; name: string; size: number; mtime: number }[] = [];
  for (const generation of await names(generations)) {
    const base = join(generations, generation), logs = join(base, 'logs');
    if (!await directory(base)) continue;
    for (const name of await names(logs)) if (/^[A-Za-z0-9_.-]+\.jsonl(?:\.[12])?$/.test(name)) {
      const path = join(logs, name), info = await regular(path);
      if (info) journals.push({ path, name: 'generations/' + generation + '/logs/' + name, size: info.size, mtime: info.mtimeMs });
    }
  }
  // Old journals only: live generations may be using a file for readiness evidence.
  for (const item of journals) if (now - item.mtime > day && !/\.[12]$/.test(item.path)) await rotate(item.path, limits.journal);
  let total = journals.reduce((n, item) => n + item.size, 0);
  if (total > limits.generations) {
    // Refresh targeted stats after rotation before pruning; no file contents read.
    const old: typeof journals = [];
    for (const generation of await names(generations)) {
      const base = join(generations, generation), logs = join(base, 'logs');
      if (!await directory(base)) continue;
      for (const name of await names(logs)) if (/^[A-Za-z0-9_.-]+\.jsonl(?:\.[12])?$/.test(name)) {
        const path = join(logs, name), info = await regular(path);
        if (info) old.push({ path, name: 'generations/' + generation + '/logs/' + name, size: info.size, mtime: info.mtimeMs });
      }
    }
    total = old.reduce((n, item) => n + item.size, 0);
    for (const item of old.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= limits.generations) break;
      if (now - item.mtime <= day) continue;
      await fs.unlink(item.path); total -= item.size; removed.push(item.name);
    }
  }
  await fs.writeFile(marker, JSON.stringify({ at: now, debugRemoved }), { mode: 0o600 });
  return { checked: true, removed };
}
export function scheduleDataMaintenance(root: string) {
  if (running.has(root)) return;
  const task = new Promise<void>(done => setImmediate(done)).then(() => maintainData(root)).catch(() => undefined)
    .finally(() => running.delete(root));
  running.set(root, task);
}
