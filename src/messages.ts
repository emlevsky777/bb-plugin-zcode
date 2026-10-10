import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Ordinary projection limits are log-only. Other diagnostics may affect the
// conversation and receive one actionable warning per code and thread.
const routine = new Set(['generic-native-tool', 'execution-fields-unavailable', 'native-tool-extra-fields',
  'file-change-kind-unavailable', 'historical-row-skipped', 'unaccepted-turn-suppressed']);
export function diagnosticMessage(code: string): string | null {
  return routine.has(code) ? null : `Some ZCode activity could not be displayed reliably. If the conversation looks incomplete, stop and contact the plugin maintainer with code ${code}.`;
}
export function createDiagnosticReporter(observe: (value: Record<string, unknown>) => void,
  emit: (threadId: string, summary: string) => void, claim?: (threadId: string, code: string) => boolean) {
  const warned = new Set<string>();
  return (threadId: string, code: string) => {
    if (!/^[a-z-]+$/.test(code)) return;
    observe({ event: 'protocol-diagnostic', threadId, code });
    const summary = diagnosticMessage(code), key = JSON.stringify([threadId, code]);
    if (!summary || warned.has(key) || (claim && !claim(threadId, code))) return;
    warned.add(key); emit(threadId, summary);
  };
}
export function claimNotice(root: string, name: string, key: string): boolean {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, name + '.json');
  try { if (JSON.parse(readFileSync(file, 'utf8')).key === key) return false; }
  catch { /* First notice or invalid state. */ }
  // Atomic publication; simultaneous claimants may show the warning twice.
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify({ key }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, file); return true;
  } finally {
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export function diagnosticNoticeName(threadId: string, code: string) {
  return 'diagnostic-' + createHash('sha256').update(JSON.stringify([threadId, code])).digest('hex');
}
