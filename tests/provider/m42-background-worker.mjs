// Own bounded Mac level1 worker; M4 listener/effect fixture reused.
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root=resolve('.'),[label,duration]=process.argv.slice(2),ms=Number(duration);
if(!root.includes('/.local/live-stand/m4-')||!['complete','stop'].includes(label)||!Number.isInteger(ms)||ms<30000||ms>300000)throw Error('Own level1 worker scope');
writeFileSync(join(root,label+'.pid'),String(process.pid),'utf8');
const server=createServer((_q,r)=>r.end('M42_OWN'));server.listen(18946,'127.0.0.1',()=>writeFileSync(join(root,label+'-listening.txt'),'18946','utf8'));
const interval=setInterval(()=>appendFileSync(join(root,label+'-heartbeat.txt'),Date.now()+'\n','utf8'),250);
let finished=false;const close=()=>{if(finished)return;finished=true;clearInterval(interval);clearTimeout(deadline);server.close();writeFileSync(join(root,label+'-closed.txt'),'M42_DONE','utf8');};
process.on('SIGTERM',close);const deadline=setTimeout(close,ms);
