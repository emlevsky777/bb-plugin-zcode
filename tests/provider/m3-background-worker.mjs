// Bounded own fixture, derived from M2 background worker; no shared files.
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve('.'), [label, duration] = process.argv.slice(2), ms = Number(duration);
if (!root.includes('/.local/live-stand/m3-') || !['baseline','after','complete','stop','release','resume','foreground','ui'].includes(label) ||
    !Number.isInteger(ms) || ms < 30000 || ms > 180000) throw Error('Own M3 scope required');
writeFileSync(join(root, label + '.pid'), String(process.pid), 'utf8');
const server = createServer((_req, response) => response.end('M3_OWN_BACKGROUND'));
server.listen(18936, '127.0.0.1', () => writeFileSync(join(root,label + '-listening.txt'),'18936','utf8'));
const timer = setInterval(() => appendFileSync(join(root,label + '-heartbeat.txt'),Date.now()+'\n','utf8'),250);
let done = false;
const close = () => { if(done)return; done=true; clearInterval(timer); server.close(); writeFileSync(join(root,label+'-closed.txt'),'M3_DONE','utf8'); };
process.on('SIGTERM',close); setTimeout(close,ms);
