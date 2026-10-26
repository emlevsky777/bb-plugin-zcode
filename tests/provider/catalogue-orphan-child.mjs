// Synthetic EOF/TERM-ignore and same-group descendant, not native semantics.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
process.on('SIGTERM', () => {}); process.stdin.resume();
if (process.argv[3] !== 'descendant') spawn(process.execPath, [import.meta.filename, root, 'descendant'], { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
const server = createServer(); server.listen(0, '127.0.0.1', () => {
  const file = join(root, process.argv[3] === 'descendant' ? 'descendant.json' : 'child.json');
  writeFileSync(file + '.tmp', JSON.stringify({ pid: process.pid, port: server.address().port }), 'utf8');
  renameSync(file + '.tmp', file);
});
setInterval(() => appendFileSync(join(root, 'heartbeat'), 'x', 'utf8'), 50);
