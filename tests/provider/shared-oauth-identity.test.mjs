import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api } from './helpers.mjs';

const identityKey = `account-provider:${api.accountProviderId}:identity`;
const sourceKey = `account-provider:${api.accountProviderId}:auth-source`;
const shared = { 'oauth:active_provider': 'zai', 'oauth:zai:user_info': '{"id":"SYNTHETIC_ACCOUNT"}',
  'oauth:zai:access_token': 'SYNTHETIC_OAUTH', zcodejwttoken: 'SYNTHETIC_START' };
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'shared-oauth-')), file = join(root, 'credentials.json');
  try { run(file); } finally { rmSync(root, { recursive: true }); }
}

function withCredentialEnvironment(values, run) {
  const names = ['ZCODE_CREDENTIAL_SECRET', 'ZCODE_CREDENTIAL_SECRET_FILE'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) {
      if (values[name] === undefined) delete process.env[name];
      else process.env[name] = values[name];
    }
    return run();
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
}

test('shared Desktop OAuth works without legacy identity, stays fresh and never writes credentials', () => fixture(file => {
  writeFileSync(file, JSON.stringify(shared));
  const auth = new api.ReadOnlyAuth(file), before = readFileSync(file);
  assert.deepEqual(auth.read().oauth, { identity: shared['oauth:zai:user_info'], accessToken: 'SYNTHETIC_OAUTH' });
  assert.deepEqual(readFileSync(file), before);
  writeFileSync(file, JSON.stringify({ ...shared, 'oauth:zai:user_info': '{"id":"OTHER_ACCOUNT"}', 'oauth:zai:access_token': 'OTHER_OAUTH' }));
  assert.deepEqual(auth.read().oauth, { identity: '{"id":"OTHER_ACCOUNT"}', accessToken: 'OTHER_OAUTH' });
  assert.equal(auth.fork('desktop', undefined, 'start-plan').read().apiKey, 'SYNTHETIC_START');
}));

test('shared identity requires the active Z.ai OAuth session and never replaces missing manual identity', () => fixture(file => {
  for (const patch of [
    { 'oauth:active_provider': 'bigmodel' }, { 'oauth:active_provider': undefined },
    { 'oauth:zai:user_info': undefined }, { 'oauth:zai:user_info': ' ' },
    { 'oauth:zai:access_token': undefined }, { 'oauth:zai:access_token': ' ' }, { [sourceKey]: 'manual' }
  ]) {
    writeFileSync(file, JSON.stringify({ ...shared, ...patch }));
    assert.throws(() => new api.ReadOnlyAuth(file).read(), error => error instanceof api.AuthError);
  }
}));

test('explicit unsupported account identities retain their plan rejection', () => fixture(file => {
  for (const provider of ['account:zai-start-plan', 'account:zai-team-coding-plan', 'account:bigmodel-individual-coding-plan']) {
    writeFileSync(file, JSON.stringify({ ...shared, [`account-provider:${provider}:identity`]: 'OTHER_ACCOUNT' }));
    assert.throws(() => new api.ReadOnlyAuth(file).read(), error => error instanceof api.UnsupportedPlanError);
  }
}));

test('legacy identity remains authoritative when shared OAuth user info also exists', () => fixture(file => {
  writeFileSync(file, JSON.stringify({ ...shared, [identityKey]: 'LEGACY_ACCOUNT' }));
  assert.equal(new api.ReadOnlyAuth(file).read().oauth.identity, 'LEGACY_ACCOUNT');
  writeFileSync(file, JSON.stringify({ ...shared, [identityKey]: 'enc:v1:invalid' }));
  assert.throws(() => new api.ReadOnlyAuth(file).read(), error => error.kind === 'invalid-store');
}));

test('v2 encrypted shared OAuth uses the native managed secret without rewriting or accepting a wrong fingerprint', async () => {
  const { createHash, createCipheriv } = await import('node:crypto');
  const { chmodSync } = await import('node:fs');
  withCredentialEnvironment({}, () => fixture(file => {
    const secret = 'SYNTHETIC_PRIVATE_MANAGED_SECRET_0123456789';
    const key = createHash('sha256').update(secret).digest();
    const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 24);
    const encrypt = value => {
      const iv = Buffer.alloc(12, 8), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return `enc:v2:env:${fingerprint}:` + [iv, cipher.getAuthTag(), bytes].map(part => part.toString('base64url')).join('.');
    };
    const keyFile = join(file, '..', 'credential-secret');
    writeFileSync(keyFile, secret, { mode: 0o600 });
    const store = Object.fromEntries(Object.entries(shared).map(([k, v]) => [k, encrypt(v)]));
    writeFileSync(file, JSON.stringify(store)); const before = readFileSync(file);
    assert.deepEqual(new api.ReadOnlyAuth(file).read().oauth,
      { identity: shared['oauth:zai:user_info'], accessToken: 'SYNTHETIC_OAUTH' });
    assert.equal(new api.ReadOnlyAuth(file).fork('desktop', undefined, 'start-plan').read().apiKey, 'SYNTHETIC_START');
    assert.deepEqual(readFileSync(file), before);
    for (const value of ['enc:v3:unknown', store['oauth:active_provider'].replace(fingerprint, '0'.repeat(24)),
      store['oauth:active_provider'].replace(':env:', ':unknown:')]) {
      writeFileSync(file, JSON.stringify({ ...store, 'oauth:active_provider': value }));
      assert.throws(() => new api.ReadOnlyAuth(file).read(), error => error.kind === 'invalid-store');
    }
    writeFileSync(file, before); chmodSync(keyFile, 0o644);
    assert.throws(() => new api.ReadOnlyAuth(file).read(), error => error.kind === 'invalid-store');
  }));
});

test('v2 env credentials accept native direct-secret semantics and reject conflicting sources', async () => {
  const { createHash, createCipheriv } = await import('node:crypto');
  withCredentialEnvironment({ ZCODE_CREDENTIAL_SECRET: 'SYNTHETIC_SHORT' }, () => fixture(file => {
    const key = createHash('sha256').update(process.env.ZCODE_CREDENTIAL_SECRET).digest();
    const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 24);
    const encrypt = value => {
      const iv = Buffer.alloc(12, 6), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return `enc:v2:env:${fingerprint}:` + [iv, cipher.getAuthTag(), bytes].map(part => part.toString('base64url')).join('.');
    };
    writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(shared).map(([k, v]) => [k, encrypt(v)]))));
    assert.equal(new api.ReadOnlyAuth(file).read().oauth.accessToken, 'SYNTHETIC_OAUTH');
    process.env.ZCODE_CREDENTIAL_SECRET_FILE = join(file, '..', 'unused-managed-secret');
    assert.throws(() => new api.ReadOnlyAuth(file).read(), error => error.kind === 'invalid-store');
  }));
});
