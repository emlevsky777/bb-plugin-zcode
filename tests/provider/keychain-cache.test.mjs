import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createKeychainReader } from '../../src/keychain-cache.ts';

const fingerprint = key => createHash('sha256').update(key).digest('hex').slice(0, 24);
test('eleven repeated callers reuse one successful Keychain read', () => {
  let calls = 0; const key = Buffer.alloc(32, 5);
  const read = createKeychainReader(() => { calls++; return key; });
  for (let i = 0; i < 11; i++) assert.equal(read('/fixture/credentials.json', fingerprint(key)), key);
  assert.equal(calls, 1);
});
test('cancellation or timeout is remembered without retrying on the next ten reads', () => {
  let calls = 0; const read = createKeychainReader(() => { calls++; throw new Error('SYNTHETIC_PRIVATE_ERROR'); });
  for (let i = 0; i < 11; i++) assert.throws(() => read('/fixture/credentials.json', 'a'.repeat(24)),
    error => !error.message.includes('PRIVATE'));
  assert.equal(calls, 1);
});
test('key rotation invalidates and clears the old key, then loads the new key once', () => {
  let calls = 0; const first = Buffer.alloc(32, 5), second = Buffer.alloc(32, 6);
  const firstFingerprint = fingerprint(first), secondFingerprint = fingerprint(second);
  const read = createKeychainReader(() => ++calls === 1 ? first : second);
  read('/fixture/credentials.json', firstFingerprint);
  assert.equal(read('/fixture/credentials.json', secondFingerprint), second);
  assert.deepEqual(first, Buffer.alloc(32));
  assert.equal(read('/fixture/credentials.json', secondFingerprint), second);
  assert.equal(calls, 2);
});
test('different credential stores do not share approved keys', () => {
  let calls = 0; const key = Buffer.alloc(32, 7);
  const read = createKeychainReader(() => { calls++; return Buffer.from(key); });
  read('/fixture/one/credentials.json', fingerprint(key));
  read('/fixture/two/credentials.json', fingerprint(key));
  assert.equal(calls, 2);
});
test('an invalid fingerprint fails closed and does not trigger repeated Keychain reads', () => {
  let calls = 0; const read = createKeychainReader(() => { calls++; return Buffer.alloc(32, 5); });
  for (let i = 0; i < 11; i++) assert.throws(() => read('/fixture/credentials.json', 'a'.repeat(24)));
  assert.equal(calls, 1);
});

for (const failure of [false, true]) test(`Coding and Start auth instances share the prompt guard (failure=${failure})`, () => {
  // Replace the OS command in a separate process; this test never accesses real
  // Keychain, credentials, account APIs, or the user's active provider worker.
  const code = `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
    import { tmpdir } from 'node:os'; import { join } from 'node:path';
    import { createCipheriv, createHash } from 'node:crypto';
    let calls = 0; const key = Buffer.alloc(32, 9);
    const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 24);
    childProcess.execFileSync = (file, args) => {
      assert.equal(file, '/usr/bin/security'); assert.equal(args[0], 'find-generic-password');
      calls++; if (${failure}) throw new Error('SYNTHETIC_CANCELLED');
      return key.toString('base64url') + '\\n';
    };
    os.platform = () => 'darwin';
    syncBuiltinESMExports();
    const { ReadOnlyAuth } = await import(${JSON.stringify(new URL('../../src/auth.ts', import.meta.url).href)});
    const root = mkdtempSync(join(tmpdir(), 'keychain-reuse-')), path = join(root, 'credentials.json');
    const encrypt = value => { const iv = Buffer.alloc(12, 4), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return 'enc:v2:os:' + fingerprint + ':' + [iv, cipher.getAuthTag(), bytes].map(x => x.toString('base64url')).join('.'); };
    try {
      const store = { 'oauth:active_provider': 'zai', 'oauth:zai:user_info': '{"id":"SYNTHETIC"}',
        'oauth:zai:access_token': 'SYNTHETIC_OAUTH', zcodejwttoken: 'SYNTHETIC_START' };
      const write = () => writeFileSync(path, JSON.stringify(Object.fromEntries(Object.entries(store).map(([k,v]) => [k,encrypt(v)]))));
      write(); const before = readFileSync(path);
      const auth = new ReadOnlyAuth(path), start = auth.fork('desktop', undefined, 'start-plan');
      for (let i = 0; i < 11; i++) {
        const reader = i % 2 ? start : new ReadOnlyAuth(path);
        if (${failure}) assert.throws(() => reader.read(), error => error.kind === 'invalid-store' && error.message.includes('Reload ZCode Provider'));
        else assert.ok(reader.read());
      }
      assert.equal(calls, 1); assert.deepEqual(readFileSync(path), before);
      if (!${failure}) { store['oauth:zai:access_token'] = 'SYNTHETIC_ROTATED_OAUTH'; write();
        assert.equal(auth.read().oauth.accessToken, 'SYNTHETIC_ROTATED_OAUTH'); assert.equal(calls, 1); }
    } finally { rmSync(root, { recursive: true }); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
});

test('alternating fingerprints cannot bypass a cancelled Keychain attempt', () => {
  let calls = 0; const read = createKeychainReader(() => { calls++; throw new Error('SYNTHETIC_CANCELLED'); });
  for (let i = 0; i < 11; i++) assert.throws(() => read('/fixture/credentials.json', (i % 2 ? 'a' : 'b').repeat(24)));
  assert.equal(calls, 1);
});
test('retired fingerprints cannot reopen Keychain after successful rotation', () => {
  let calls = 0; const first = Buffer.alloc(32, 5), second = Buffer.alloc(32, 6);
  const a = fingerprint(first), b = fingerprint(second);
  const read = createKeychainReader(() => ++calls === 1 ? first : second);
  read('/fixture/credentials.json', a); read('/fixture/credentials.json', b);
  for (let i = 0; i < 11; i++) assert.throws(() => read('/fixture/credentials.json', a));
  assert.equal(read('/fixture/credentials.json', b), second);
  assert.equal(calls, 2);
});
