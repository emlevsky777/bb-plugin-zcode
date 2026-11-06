import { appendFileSync } from 'node:fs';
import { readDiscovery } from '../../src/discovery-cache.ts';
const root = process.argv[2];
const value = await readDiscovery(root, 'balance', 'fixture-scope', 60_000, async () => {
  appendFileSync(root + '/requests', 'GET balance\n');
  await new Promise(r => setTimeout(r, 80)); return { absent: true };
}, v => { if (v?.absent !== true) throw Error('invalid'); return v; });
console.log(JSON.stringify(value));
