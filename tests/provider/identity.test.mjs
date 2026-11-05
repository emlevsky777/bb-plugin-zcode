import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { plugin } from './helpers.mjs';

test('distinct manifest identity registers one provider/CLI and reads only its own plugin state with fresh defaults', async () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.name, 'bb-plugin-zcode-provider');
  assert.equal(pkg.version, '0.2.1');
  assert.equal(pkg.bb.name, 'ZCode Provider');
  // Installed bb derives the ID from the final package-name component.
  const pluginId = pkg.name.split('/').at(-1).replace(/^bb-plugin-/, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  assert.equal(pluginId, 'zcode-provider');
  const dataDir = mkdtempSync(join(tmpdir(), 'zcode-identity-'));
  const hosts = [];
  try {
    for (const [id, event] of [[pluginId, 'native-startup'], ['zcode', 'native-mcp-degraded']]) {
      const root = join(dataDir, 'plugins', id, 'bridge-data/zcode');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'service-evidence.ndjson'), JSON.stringify({ event }) + '\n');
    }
    for (const [id, expected] of [[pluginId, 'native-startup'], ['zcode', 'native-mcp-degraded']]) {
      const { bb, harness } = createFakePluginHost({ pluginId: id, dataDir });
      hosts.push(harness);
      await plugin(bb);
      assert.deepEqual(harness.registrations.providerRegistrations.map(p => [p.id, p.displayName]), [['zcode-provider', 'ZCode Provider']]);
      assert.equal(harness.registrations.cli.name, 'zcode-provider-report');
      const help = await harness.runCli(['--help'], {});
      assert.equal(help.exitCode, 0);
      assert.match(help.stdout, /zcode-provider-report/);
      assert.doesNotMatch(help.stdout, /\bzcode-report\b/);
      const result = await harness.runCli(['--json'], {});
      assert.equal(result.exitCode, 0);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(report.events, [expected]);
      assert.deepEqual(report.settings, { authMode: 'desktop', memoryEnabled: true, subagentsDisabled: false, backupKey: 'not set' });
    }
  } finally {
    for (const harness of hosts) harness.dispose();
    rmSync(dataDir, { recursive: true });
  }
});
