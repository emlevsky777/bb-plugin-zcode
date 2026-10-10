// Bounded own native Bash fixture for Stop2/3: process, listener and late effects.
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const [base, label, rawPort] = process.argv.slice(2), root = resolve(base ?? ''), port = Number(rawPort);
if (!root.includes('/.local/live-stand/m2-') || !['stop2','stop3'].includes(label) || ![18926,18927].includes(port)) throw Error('Own M2 scope required');
writeFileSync(join(root, label + '-bg.pid'), String(process.pid), 'utf8');
const server = createServer((_req, response) => response.end('M2_OWN_BACKGROUND'));
server.listen(port, '127.0.0.1', () => {
  writeFileSync(join(root, label + '-listening.txt'), String(port), 'utf8');
});
const timer = setInterval(() => appendFileSync(join(root, label + '-heartbeat.txt'), Date.now() + '\n', 'utf8'), 250);
const close = () => { clearInterval(timer); server.close(); };
process.on('SIGTERM', close); setTimeout(close, 300000);
