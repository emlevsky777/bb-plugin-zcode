// Actual services.models with explicitly injected fake V4 from existing fixture.
import { resolve, join } from 'node:path';
import { writeFileSync } from 'node:fs';
const api = await import(process.env.ZCODE_TEST_ARTIFACT === '1' ? '../../dist/index.js' : '../../src/index.ts');
const root = process.argv[2], pause = process.argv[3] === 'pause';
const auth = new api.ReadOnlyAuth(join(root, 'auth.json')); auth.read = () => ({ apiKey: 'SYNTHETIC_ONLY' });
const runtime = api.createNativeServices(join(root, 'shared'), { auth, catalogueCache: true,
  discovery: () => ({ installed: true, supported: true, sha256: 'synthetic', version: 'synthetic' }),
  paths: { executable: process.execPath, script: resolve('tests/provider/fake-v4.mjs'), builtin: join(root, 'builtin.json') },
  configure: async child => {
    await child.request('runtime/capabilities', {});
    if (pause) { writeFileSync(join(root, 'paused.json'), JSON.stringify({ pid: child.child.pid }), 'utf8'); await new Promise(() => {}); }
  } });
try { const value = await runtime.services.models(); process.stdout.write(JSON.stringify(value)); }
finally { await runtime.close(); }
