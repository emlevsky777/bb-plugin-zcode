import { record } from './errors.ts';
import type { Warn } from './errors.ts';
import type { Snapshot } from './native.ts';

export type Outcome = 'completed' | 'failed' | 'interrupted';
export const headerOutcomes: Record<string, Outcome> = Object.assign(Object.create(null), {
  completedSuccess: 'completed', failed: 'failed', completedInterrupted: 'interrupted',
});
const phaseOutcomes: Record<string, Outcome> = Object.assign(Object.create(null), {
  completedSuccess: 'completed', error: 'failed', completedInterrupted: 'interrupted',
});
// Minimal own model, pinned V4 snapshot.ts + accepted traces; no private imports.
export function inspectExecution(snapshot: Snapshot, warn: Warn): {
  present: boolean; known: boolean; active: boolean; foregroundActive: boolean; waiting: boolean; blocked: boolean;
  outcome: Outcome | undefined;
} {
  if (snapshot.control === undefined) {
    warn({ code: 'execution-fields-unavailable' });
    return { present: false, known: false, active: false, foregroundActive: false, waiting: false, blocked: false, outcome: undefined };
  }
  const control = record(snapshot.control);
  const phase = control.phase;
  let known = ['draft', 'prewarming', 'running', 'completedSuccess', 'completedInterrupted', 'error'].includes(String(phase));
  if (!known) warn({ code: 'unknown-control-phase' }, phase);
  const arrays = [control.activeWorks, snapshot.backgroundWorks, snapshot.pendingInteractions];
  if (arrays.some(a => !Array.isArray(a))) { known = false; warn({ code: 'execution-fields-unavailable' }); }
  const activeWorks = Array.isArray(control.activeWorks) ? control.activeWorks : [];
  const background = Array.isArray(snapshot.backgroundWorks) ? snapshot.backgroundWorks : [];
  const pending = Array.isArray(snapshot.pendingInteractions) ? snapshot.pendingInteractions : [];
  for (const work of activeWorks) {
    if (!['primaryTurn', 'foregroundSubagent', 'compact', 'goalVerifier', 'goalContinuation', 'turnSteer'].includes(String(record(work).kind))) {
      known = false; warn({ code: 'unknown-active-work' });
    }
  }
  let backgroundActive = false, backgroundBlocking = false;
  for (const work of background) {
    const item = record(work), status = item.status;
    if (!['bash', 'subagent', 'workflow'].includes(String(item.kind))) {
      known = false; warn({ code: 'unknown-background-kind' });
    }
    if (!['running', 'resultPending', 'failed', 'cancelled'].includes(String(status))) {
      known = false; warn({ code: 'unknown-background-work' });
    }
    if (status === 'running' || status === 'resultPending') backgroundActive = true;
    // Pinned native subagent backgroundWorks outlive a completed primary turn,
    // including resultPending after the automatic child notification. Like Bash,
    // they keep resource ownership active but do not block foreground boundaries.
    // Child success is established separately by Subagents, never by this phase.
    if ((status === 'running' || status === 'resultPending') && item.kind === 'workflow') backgroundBlocking = true;
  }
  for (const interaction of pending) if (!['permission', 'userInput'].includes(String(record(interaction).kind))) {
    known = false; warn({ code: 'unknown-pending-interaction' });
  }
  const waiting = pending.length > 0;
  const retrying = control.apiRetry !== undefined && control.apiRetry !== null;
  const active = retrying || activeWorks.length > 0 || backgroundActive || phase === 'running' || phase === 'prewarming';
  const foregroundActive = retrying || activeWorks.length > 0 || backgroundBlocking || phase === 'running' || phase === 'prewarming';
  const blocked = retrying || activeWorks.length > 0 || backgroundBlocking || waiting;
  const outcome = known && !blocked ? phaseOutcomes[String(phase)] : undefined;
  if (phaseOutcomes[String(phase)] && blocked) warn({ code: 'terminal-with-outstanding-work' });
  return { present: true, known, active, foregroundActive, waiting, blocked, outcome };
}
