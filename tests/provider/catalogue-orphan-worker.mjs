import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
const artifact = process.env.ZCODE_TEST_ARTIFACT === '1';
const { NativeProcess } = await import(artifact ? '../../dist/process.js' : '../../src/process.ts');
const root = process.argv[2];
const launch = { executable: process.execPath, args: [resolve('tests/provider/catalogue-orphan-child.mjs'), root] };
const child = new NativeProcess({ ...launch, cwd: root, env: process.env }, 1, null, () => {}, () => {});
writeFileSync(join(root, 'group.json'), JSON.stringify({ pid: child.child.pid }), 'utf8');
setInterval(() => {}, 1000);
