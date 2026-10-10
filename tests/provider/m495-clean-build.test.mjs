import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { observerEnvironment } from '../../src/observer.ts';
import { maintainData, dataLimits } from '../../src/data-maintenance.ts';
import { reportEvents, formatProblemReport } from '../../src/problem-report.ts';
import { api } from './helpers.mjs';
test('observer absent is inert; only owned loopback and canonical CA allowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'm495-'));
  try {
    assert.deepEqual(observerEnvironment(root), {}); assert.deepEqual(readdirSync(root), []);
    const ca = join(root, 'ca'); writeFileSync(ca, 'SYNTHETIC');
    const config = value => writeFileSync(join(root, 'observer.json'), JSON.stringify(value));
    config({ proxy: 'http://127.0.0.1:12345', ca });
    assert.deepEqual(observerEnvironment(root), { ZCODE_HTTP_PROXY: 'http://127.0.0.1:12345', ZCODE_AGENT_CA_CERT: ca });
    for (const proxy of ['http://remote:12345', 'http://127.0.0.1:0', 'http://127.0.0.1:65536']) {
      config({ proxy, ca }); assert.throws(() => observerEnvironment(root), /Observer/);
    }
    symlinkSync('/etc/hosts', join(root, 'foreign')); config({ proxy: 'http://127.0.0.1:12345', ca: join(root, 'foreign') });
    assert.throws(() => observerEnvironment(root), /Observer/);
    const env = api.childEnvironment({ ZCODE_RUNTIME_ENV: 'development', ZCODE_HTTP_PROXY: 'foreign', NODE_EXTRA_CA_CERTS: 'foreign' }, { HOME: root });
    for (const name of ['ZCODE_RUNTIME_ENV', 'ZCODE_HTTP_PROXY', 'ZCODE_AGENT_CA_CERT', 'NODE_EXTRA_CA_CERTS']) assert.equal(env[name], undefined);
  } finally { rmSync(root, { recursive: true }); }
});
test('journal rotation, budget, daily gate, legacy cleanup preserve history and reject symlinks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'm495-')), now = Date.now();
  const put = (name, text) => { const path = join(root, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); return path; };
  try {
    const binding = put('thread-homes-v2/own/bb-binding.json', 'IDENTITY');
    const history = put('thread-homes-v2/own/.zcode/cli/db/db.sqlite', 'HISTORY');
    put('service-evidence.ndjson', '01234567890'); put('auth-metadata.ndjson', '01234567890');
    put('data/cli/debug/model-io-own.jsonl', 'PROMPT'); put('data/cli/debug/keep.jsonl', 'KEEP');
    symlinkSync(history, join(root, 'data/cli/debug/model-io-symlink.jsonl'));
    const old = put('generations/old/logs/main.jsonl', '012345678901234567890'); utimesSync(old, new Date(now - 3 * dataLimits.interval), new Date(now - 3 * dataLimits.interval));
    const active = put('generations/active/logs/main.jsonl', 'ACTIVE');
    const limits = { ...dataLimits, journal: 10, generations: 10 };
    const first = await maintainData(root, now, limits); assert.equal(first.checked, true);
    assert.equal(readFileSync(join(root, 'service-evidence.ndjson.1'), 'utf8'), '01234567890');
    assert.equal(existsSync(join(root, 'data/cli/debug/model-io-own.jsonl')), false);
    assert.equal(readFileSync(binding, 'utf8'), 'IDENTITY'); assert.equal(readFileSync(history, 'utf8'), 'HISTORY');
    assert.equal(readFileSync(active, 'utf8'), 'ACTIVE'); assert.equal(existsSync(old + '.1'), false);
    assert.equal((await maintainData(root, now + 100, limits)).checked, false);
    for (let i = 1; i <= 3; i++) { put('service-evidence.ndjson', '01234567890'); await maintainData(root, now + i * dataLimits.interval, limits); }
    assert.equal(existsSync(join(root, 'service-evidence.ndjson.3')), false);
    put('data/cli/debug/model-io-later.jsonl', 'KEEP AFTER MIGRATION');
    await maintainData(root, now + 4 * dataLimits.interval, limits);
    assert.equal(existsSync(join(root, 'data/cli/debug/model-io-later.jsonl')), true);
  } finally { rmSync(root, { recursive: true }); }
});
test('problem report whitelist excludes synthetic key, token, prompt and workspace path', () => {
  const root = mkdtempSync(join(tmpdir(), 'm495-'));
  try {
    const secrets = ['FAKE_KEY_495', 'FAKE_TOKEN_495', 'FAKE_PROMPT_495', '/private/project-495'];
    writeFileSync(join(root, 'service-evidence.ndjson'), [
      { event: 'native-startup', apiKey: secrets[0], token: secrets[1], prompt: secrets[2], cwd: secrets[3] },
      { event: secrets[2], code: secrets[0] }, { event: 'protocol-diagnostic', code: secrets[1] },
    ].map(JSON.stringify).join('\n'));
    const output = formatProblemReport({ bb: '0.45.0', ZCode: '3.14.4', CLI: '0.16.9', plugin: '0.0.0', macOS: '26.0',
      state: 'installed', ZCodePath: '/Applications/ZCode.app', cliLogin: 'set', events: reportEvents(root), prompt: secrets[2] },
      { backupKey: secrets[0], token: secrets[1], prompt: secrets[2], cwd: secrets[3], authMode: secrets[2] });
    for (const secret of secrets) assert.equal(output.includes(secret), false);
    assert.match(output, /"backupKey": "set"/); assert.match(output, /native-startup/);
  } finally { rmSync(root, { recursive: true }); }
});
