import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { reportCli } from '../../src/report-cli.ts';
import { reportEvents } from '../../src/problem-report.ts';

const sentinel = 'SENTINEL_private_prompt_token_header_/home/private/project';
const local = { bb: '0.47.1', ZCode: '3.15.1', CLI: '0.16.9', plugin: '0.1.0', macOS: '26.0',
  state: 'installed', ZCodePath: sentinel, cliLogin: 'set', events: ['native-startup', sentinel] };
function safe(result) {
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  assert.ok(Buffer.byteLength(output, 'utf8') <= 1048576);
  assert.equal(output.includes(sentinel), false);
  return output;
}
test('report CLI root metadata, help, usage, JSON and server-local scope through SDK harness', async () => {
  let reads = 0;
  const cli = reportCli(async () => { reads++; return { local, settings: { backupKey: sentinel, headers: sentinel, prompt: sentinel } }; });
  const { bb, harness: sdk } = createFakePluginHost({ pluginId: 'report-test' }); bb.cli.register(cli);
  assert.equal(cli.rendersHelp, true); assert.ok(Array.isArray(cli.commands));
  const ctx = { get cwd() { throw Error('remote invoking host path must never be read'); } };
  for (const argv of [['--help'], ['-h'], ['help'], ['--json', '--help']]) {
    const result = await sdk.runCli(argv, ctx); assert.equal(result.exitCode, 0); assert.match(safe(result), /server-local/);
  }
  for (const argv of [[sentinel], ['--' + sentinel], ['--json', sentinel], ['--json=true', sentinel], ['--json', '--json=' + sentinel], ['--', sentinel], ['--', '--json']]) {
    const result = await sdk.runCli(argv, ctx); assert.equal(result.exitCode, 2); safe(result);
    const json = argv[0] !== '--' && argv.some(v => v === '--json' || v === '--json=true');
    if (json) assert.equal(JSON.parse(result.stdout).error.code, 'invalid_arguments');
    else assert.equal(result.stdout, '');
  }
  assert.equal(reads, 0);
  const json = await sdk.runCli(['--json'], ctx); assert.equal(json.exitCode, 0); safe(json);
  const report = JSON.parse(json.stdout);
  assert.equal(report.scope, 'server-local'); assert.equal(report.remoteAgentDiagnostics, false);
  assert.equal(report.desktopCredentialFile, 'present'); assert.equal(report.signInReadiness, 'not checked');
  assert.equal(report.ZCodePath, undefined); assert.equal(report.cliLogin, undefined);
  assert.deepEqual(report.events, ['native-startup']); assert.equal(report.settings.backupKey, 'set');
  const text = await sdk.runCli([], ctx); assert.match(safe(text), /server-local/); assert.equal(reads, 2);
  sdk.dispose();
});
test('report failures, hostile fields and missing data cannot leak content or become success', async () => {
  for (const argv of [[], ['--json']]) {
    const cli = reportCli(async () => { throw Error(sentinel.repeat(30000)); });
    const result = await cli.run(argv, {}); assert.equal(result.exitCode, 1); safe(result);
    if (argv.length) assert.equal(JSON.parse(result.stdout).error.code, 'report_unavailable');
  }
  const cli = reportCli(async () => ({ local: { ...local, bb: sentinel, macOS: sentinel, ZCode: sentinel,
    CLI: sentinel, plugin: sentinel, state: sentinel, cliLogin: sentinel, events: Array(30000).fill(sentinel) }, settings: { authMode: sentinel } }));
  const result = await cli.run(['--json'], {}); safe(result);
  const report = JSON.parse(result.stdout); assert.equal(report.bb, null); assert.deepEqual(report.events, []);
  assert.equal(report.desktopCredentialFile, 'absent'); assert.equal(report.settings.authMode, 'desktop');
});
test('report projects fixed events from logs without writing session/config files', () => {
  const root = mkdtempSync(join(tmpdir(), 'report-'));
  try {
    const file = join(root, 'service-evidence.ndjson');
    const bytes = [{ event: 'native-startup', prompt: sentinel }, { event: sentinel },
      { event: 'protocol-diagnostic', code: 'unknown-native-event', raw: sentinel },
      { event: 'protocol-diagnostic', code: sentinel }].map(JSON.stringify).join('\n');
    writeFileSync(file, bytes); mkdirSync(join(root, 'generations/g/logs'), { recursive: true });
    writeFileSync(join(root, 'generations/g/logs/native.jsonl'), JSON.stringify({ event: 'mcp.startup.failed', error: sentinel }));
    assert.deepEqual(reportEvents(root), ['native-startup', 'protocol-diagnostic:unknown-native-event', 'protocol-diagnostic', 'native-mcp-degraded']);
    assert.equal(readFileSync(file, 'utf8'), bytes); assert.deepEqual(reportEvents(join(root, 'missing')), []);
  } finally { rmSync(root, { recursive: true }); }
});
