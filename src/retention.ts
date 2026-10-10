import { isDeepStrictEqual } from 'node:util';
import type { Snapshot } from './native.ts';

// Pinned transcript-hydration synthesizes clocks/sequence numbers. Only their
// numeric values are display metadata; presence/type remains significant.
const clocks = new Set(['createdAt', 'createdAtSeq']);
const turnClocks = new Set(['startedAt', 'endedAt', 'activeMs']);
function comparable(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
    (clocks.has(key) || row.kind === 'turnHeader' && turnClocks.has(key)) &&
      typeof value === 'number' && Number.isFinite(value) ? 0 : value]));
}
// CLI0.16.9 cold hydration synthesizes durable message parts, not HookRun UI
// rows. Tool UI placement/clocks also differ on an OFF cold resume: the
// synthesizer replays durable tool parts ahead of assistant text parts.
// This narrow fallback preserves message order, tool order, every payload and
// unknown field; unknown/running hook forms never qualify for exclusion.
const hookKeys = new Set(['rowId','turnId','entityId','productTurnId','visibility','createdAt','createdAtSeq',
  'kind','hookInvocationId','hookEventName','hookCount','state','startedAt','endedAt','durationMs','lane','anchorToolCallId','executions']);
const executionKeys = new Set(['hookRunId','hookIndex','didExecute','state','outcome','blockReason','startedAt','endedAt','durationMs','displayName','sourceKind','pluginName','toolName']);
const hookEvents = new Set(['SessionStart','UserPromptSubmit','PreToolUse','PermissionRequest','PostToolUse','PostToolUseFailure','Stop']);
const durableKinds = new Set(['turnHeader','userInput','assistantText','reasoning','toolCall','timelineMarker']);
function settledHook(row: Record<string, unknown>) {
  return row.kind === 'hookInvocation' && Object.keys(row).every(k => hookKeys.has(k)) &&
    ['turnId','entityId','productTurnId','anchorToolCallId'].every(k => row[k] === undefined || typeof row[k] === 'string') &&
    (row.visibility === undefined || row.visibility === 'visible') &&
    ['rowId','createdAt','createdAtSeq','durationMs'].every(k => row[k] === undefined || typeof row[k] === 'number' && Number.isFinite(row[k])) &&
    ['completed','failed'].includes(String(row.state)) && typeof row.hookInvocationId === 'string' &&
    hookEvents.has(String(row.hookEventName)) && Number.isSafeInteger(row.hookCount) && Number(row.hookCount) > 0 &&
    typeof row.startedAt === 'number' && Number.isFinite(row.startedAt) && typeof row.endedAt === 'number' && Number.isFinite(row.endedAt) &&
    ['assistantWork','toolBefore','toolAfter'].includes(String(row.lane)) && Array.isArray(row.executions) && row.executions.length === row.hookCount &&
    row.executions.every(e => e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).every(k => executionKeys.has(k)) &&
      ['completed','failed'].includes(e.state) && typeof e.hookRunId === 'string' && Number.isSafeInteger(e.hookIndex) &&
      e.hookIndex >= 0 && e.hookIndex < Number(row.hookCount) && typeof e.displayName === 'string' &&
      typeof e.startedAt === 'number' && Number.isFinite(e.startedAt) && typeof e.endedAt === 'number' && Number.isFinite(e.endedAt) &&
      ['pluginName','toolName','blockReason'].every(k => e[k] === undefined || typeof e[k] === 'string') &&
      (e.durationMs === undefined || typeof e.durationMs === 'number' && Number.isFinite(e.durationMs) && e.durationMs >= 0) &&
      typeof e.didExecute === 'boolean' && ['user','plugin','project'].includes(e.sourceKind) &&
      (e.outcome === undefined || ['success','blocked','failed','cancelled','timed_out'].includes(e.outcome))) &&
    new Set(row.executions.map(e => e.hookRunId)).size === row.executions.length && new Set(row.executions.map(e => e.hookIndex)).size === row.executions.length;
}
function hydratedComparable(row: Record<string, unknown>) {
  const value = comparable(row);
  for (const key of ['rowId', ...(row.kind === 'toolCall' ? ['startedAt','endedAt'] : [])])
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) value[key] = 0;
  return value;
}
function hookHydration(before: Snapshot | null, after: Snapshot | null) {
  if (!before || !after || before.rows.window.length !== before.rows.totalCount || after.rows.window.length !== after.rows.totalCount) return null;
  const hooks = before.rows.window.filter(r => r.kind === 'hookInvocation');
  if (!hooks.every(settledHook) || after.rows.window.some(r => r.kind === 'hookInvocation')) return null;
  const a = before.rows.window.filter(r => r.kind !== 'hookInvocation'), b = after.rows.window;
  if (a.length !== b.length || [...a,...b].some(r => !durableKinds.has(r.kind) || typeof r.entityId !== 'string' || !r.entityId || !Number.isSafeInteger(r.rowId))) return null;
  const groups = (rows: typeof a) => {
    const out: {turnId: string; messages: Record<string,unknown>[]; tools: Record<string,unknown>[]}[] = [], seen = new Set<string>(), entities = new Set<string>();
    for (const row of rows) {
      if (typeof row.turnId !== 'string' || !row.turnId) return null;
      const key = JSON.stringify([row.turnId,row.kind,row.entityId]); if (entities.has(key)) return null; entities.add(key);
      if (out.at(-1)?.turnId !== row.turnId) {
        if (seen.has(row.turnId)) return null; seen.add(row.turnId);
        out.push({turnId:row.turnId,messages:[],tools:[]});
      }
      const group = out.at(-1)!;
      (row.kind === 'toolCall' ? group.tools : group.messages).push(hydratedComparable(row));
    }
    return out;
  };
  const left = groups(a), right = groups(b);
  return left && right && isDeepStrictEqual(left,right) ? {omittedSettledHookRows:hooks.length, scope:'known native cold hook hydration; durable message/tool order and payloads'} : null;
}
// Object member order is not content; arrays, identities and unknowns are.
export function retainedRows(before: Snapshot | null, after: Snapshot | null): boolean {
  return (!!before && !!after && before.rows.totalCount === after.rows.totalCount &&
    isDeepStrictEqual(before.rows.window.map(comparable), after.rows.window.map(comparable))) || hookHydration(before,after) !== null;
}

// Safe diagnosis: names/types and equality only, never values or value hashes.
export function retentionDifference(before: Snapshot | null, after: Snapshot | null) {
  if (!before || !after) return { snapshotsPresent: false };
  const fields: { index: number; field: string; beforeType: string; afterType: string }[] = [];
  const type = (v: unknown) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  for (let index = 0; index < Math.max(before.rows.window.length, after.rows.window.length); index++) {
    const a: Record<string, unknown> = before.rows.window[index] ?? {}, b: Record<string, unknown> = after.rows.window[index] ?? {};
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (!isDeepStrictEqual(a[field], b[field])) fields.push({ index, field, beforeType: type(a[field]), afterType: type(b[field]) });
  }
  return { snapshotsPresent: true, semanticEqual: retainedRows(before, after),
    serializedEqual: JSON.stringify(before.rows.window) === JSON.stringify(after.rows.window),
    ...(hookHydration(before,after) ? {hookHydration:hookHydration(before,after)} : {}), fields };
}
