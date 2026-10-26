import { defineCli, cliCommand, PluginCliError } from '@get-bb/plugin-sdk';
import { problemReport, formatProblemReport, localProblemReport } from './problem-report.ts';

// Collection is separate so help/usage never touches settings or the filesystem.
export function reportCli(collect: () => Promise<{ local: ReturnType<typeof localProblemReport>; settings: Record<string, unknown> }>) {
  const summary = 'Print a safe server-local ZCode problem report';
  const cli = defineCli({ name: 'zcode-report', summary, usageErrorExitCode: 2,
    description: 'Runs on the bb server, not the invoking or remote agent host. No upload. Credential-file presence does not establish sign-in readiness.',
    commands: {}, root: cliCommand({ summary,
      options: { json: { type: 'boolean', description: 'Print the server-local report as JSON' } },
      async run({ options }) {
        try {
          const { local, settings } = await collect();
          return { exitCode: 0, stdout: options.json ? JSON.stringify(problemReport(local, settings), null, 2) + '\n' : formatProblemReport(local, settings) };
        } catch { throw new PluginCliError('Server-local ZCode report unavailable; check plugin status.', { code: 'report_unavailable' }); }
      } }) });
  return { ...cli, async run(argv: string[], ctx: Parameters<typeof cli.run>[1]) {
    const result = await cli.run(argv, ctx);
    if (result.exitCode !== 2) return result;
    // SDK usage errors echo supplied argv. Do not expose arbitrary caller text.
    const message = 'Invalid arguments. Run bb zcode-report --help. Report scope: server-local.';
    const scanned = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
    const json = scanned.some(value => value === '--json' || value === '--json=true');
    return { exitCode: 2, stderr: message + '\n', ...(json ? {
      stdout: JSON.stringify({ ok: false, error: { code: 'invalid_arguments', message } }) + '\n' } : {}) };
  } };
}
