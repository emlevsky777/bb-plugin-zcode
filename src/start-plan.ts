// Start balance semantics adapted from installed ZCode Desktop 3.17.2 (Apache-2.0).
// No model transport, credential cache, polling or retry is implemented here.
import { readFileSync } from 'node:fs';
import { homedir, version } from 'node:os';
import { join } from 'node:path';
import { record } from './errors.ts';
import { tokenRequest } from './project-token.ts';
import type { ReadOnlyAuth } from './auth.ts';
import { AuthError } from './auth.ts';
import { ProjectTokenError } from './project-token.ts';
import type { ProviderUsage } from '@get-bb/plugin-sdk/provider-bridge';
import { providerUsageSchema } from '@get-bb/plugin-sdk/provider-bridge';

export interface StartEntitlement { modelIds: string[]; validUntil: number }
export interface StartBalance { entitlement?: StartEntitlement; granted?: boolean; validUntil?: number; usage: ProviderUsage }
export function decodeStartBalance(value: unknown): StartBalance {
  const v = record(value), e = record(v.entitlement ?? {});
  if (v.entitlement !== undefined && (!Array.isArray(e.modelIds) || !e.modelIds.length ||
      !e.modelIds.every(id => typeof id === 'string' && id.length > 0) || typeof e.validUntil !== 'number' || !Number.isFinite(e.validUntil))) throw Error('Invalid Start snapshot');
  if (v.granted !== undefined && typeof v.granted !== 'boolean' || v.validUntil !== undefined && (typeof v.validUntil !== 'number' || !Number.isFinite(v.validUntil))) throw Error('Invalid Start snapshot');
  return { ...(v.entitlement === undefined ? {} : { entitlement: e as unknown as StartEntitlement }),
    ...(v.granted === undefined ? {} : { granted: v.granted as boolean }),
    ...(v.validUntil === undefined ? {} : { validUntil: v.validUntil as number }), usage: providerUsageSchema.parse(v.usage) };
}
const number = (v: unknown): number | undefined => {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim())) return;
  const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const deadline = (v: unknown): number | undefined => { const n = number(v); return n && n * 1000; };
const formatTime = (time: number) => new Date(time).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
export function startBalance(value: unknown, nativeIds: string[], now = Date.now(), serverDate?: number): StartBalance {
  const envelope = record(value);
  if (![0, 200].includes(Number(envelope.code)) || envelope.success === false) throw Error('Start Plan balance rejected; check Desktop sign-in and entitlement.');
  const data = record(envelope.data);
  const server = serverDate !== undefined && Number.isFinite(serverDate) ? serverDate
    : (typeof data.server_time === 'number' && Number.isFinite(data.server_time) && data.server_time >= 0 ? data.server_time * 1000 : now);
  const plans: Record<string, unknown>[] = (Array.isArray(data.plans) ? data.plans : []).map(record).map(p => ({ ...p,
    status: String(p.status ?? '').trim().toLowerCase() === 'active' && Number(p.ends_at) > 0 && Number(p.ends_at) * 1000 <= server ? 'expired' : String(p.status ?? '').trim().toLowerCase() }));
  const associated = (b: Record<string, unknown>) => plans.filter(p => b.user_plan_id && p.user_plan_id ? b.user_plan_id === p.user_plan_id : b.plan_id === p.plan_id);
  const all = (Array.isArray(data.balances) ? data.balances : []).map(record);
  const entitlements = (b: Record<string, unknown>) => associated(b).flatMap(p =>
    (Array.isArray(p.entitlements) ? p.entitlements : []).map(record).filter(e => b.entitlement_id && e.entitlement_id === b.entitlement_id));
  const starts = (b: Record<string, unknown>) => [b.period_start, b.effective_at, ...associated(b).map(p => p.starts_at), ...entitlements(b).map(e => e.effective_at)]
    .map(deadline).filter((t): t is number => t !== undefined);
  const start = (b: Record<string, unknown>) => { const times = starts(b); return times.length ? Math.max(...times) : undefined; };
  const expiry = (b: Record<string, unknown>) => {
    const times = [b.expires_at, b.period_end, ...associated(b).map(p => p.ends_at)].map(deadline).filter((t): t is number => t !== undefined);
    return times.length ? Math.min(...times) : undefined;
  };
  const balances = all.filter(b => {
    const linked = associated(b), end = expiry(b);
    return (!linked.length || linked.some(p => p.status !== 'expired')) && (end === undefined || end > server);
  });
  const current = balances.filter(b => (start(b) ?? server) <= server);
  const ids = current.filter(b => number(b.available_units ?? b.remaining_units) !== 0).flatMap(b => {
    const capabilities = (Array.isArray(b.capabilities) ? b.capabilities : []).filter((c): c is string => typeof c === 'string')
      .map(c => c.trim()).filter(c => c.toLowerCase().startsWith('model:')).map(c => c.slice(6).trim()).filter(Boolean);
    return capabilities.length ? capabilities : [typeof b.show_name === 'string' ? b.show_name.trim() : ''];
  });
  const modelIds = [...new Set(ids.flatMap(id => nativeIds.filter(native => native.toLowerCase() === id.toLowerCase())))];
  // Map server time to a local deadline; scheduled changes also bound reuse.
  const planEntitlements = plans.flatMap(p => (Array.isArray(p.entitlements) ? p.entitlements : []).map(record));
  const boundaries = [...plans, ...balances, ...planEntitlements].flatMap(p => ['ends_at', 'starts_at', 'start_at', 'effective_at', 'expires_at', 'period_start', 'period_end'].map(k => Number(p[k]) * 1000))
    .filter(t => Number.isFinite(t) && t > server);
  const validUntil = boundaries.length ? now + Math.min(...boundaries) - server : now;
  const windows: { label: string; usedPercent: number; resetsAt: string | null }[] = [];
  let invalidAmount = false;
  for (const b of balances) {
    const total = number(b.total_units), used = number(b.used_units), remaining = number(b.remaining_units), end = expiry(b);
    if (b.unit_type !== 'token' || b.meter !== 'model_usage' || total === undefined || total <= 0 || used === undefined || remaining === undefined || used > total || remaining > total) {
      if (current.includes(b)) invalidAmount = true;
      continue;
    }
    const models = (Array.isArray(b.capabilities) ? b.capabilities : []).filter((c): c is string => typeof c === 'string' && c.startsWith('model:')).map(c => c.slice(6));
    const begin = start(b), startLabel = begin !== undefined && begin > server ? ` · Start access begins ${formatTime(begin)}` : '';
    const endLabel = end === undefined ? 'Start expiry unreported' : `Start access expires ${formatTime(end)}`;
    windows.push({ label: `${remaining.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} tokens remaining${balances.length > 1 && models.length ? ` (${models.join(', ')})` : ''} · ${endLabel}${startLabel}`,
      usedPercent: Math.round(10000 * used / total) / 100, resetsAt: end === undefined ? null : new Date(end).toISOString() });
  }
  const error = (message: string): ProviderUsage => ({ status: 'error', accountEmail: null, planLabel: 'Start Plan', message });
  const granted = balances.length > 0 || plans.some(p => p.status !== 'expired' && (deadline(p.ends_at) ?? Infinity) > server);
  const expired = !granted && (all.length > 0 || plans.some(p => p.status === 'expired'));
  const pending = !current.length && (balances.some(b => (start(b) ?? server) > server) || plans.some(p =>
    p.status !== 'expired' && [p.starts_at, ...(Array.isArray(p.entitlements) ? p.entitlements : []).map(e => record(e).effective_at)]
      .map(deadline).some(t => t !== undefined && t > server)));
  const pendingStarts = [...balances.flatMap(starts), ...plans.map(p => deadline(p.starts_at)), ...planEntitlements.map(e => deadline(e.effective_at))]
    .filter((t): t is number => t !== undefined && t > server);
  const pendingLabel = 'Start Plan · pending activation' + (pendingStarts.length ? ` · Starts ${formatTime(Math.min(...pendingStarts))}` : '');
  const usage: ProviderUsage = expired ? { status: 'expired' }
    : invalidAmount ? error('Start Plan token amount unavailable or unsupported; check ZCode Desktop.')
    : windows.length ? { status: 'ok', accountEmail: null, planLabel: current.length ? 'Start Plan' : pendingLabel, windows }
    // bb 0.48.1 resource collection discards error measurements (and their text).
    // Empty buckets distinguish a known grant awaiting a reported balance
    // from a measured absence. Neither state fabricates amounts or models.
    : { status: 'ok', accountEmail: null, planLabel: pending ? pendingLabel
      : granted ? 'Start Plan · claimed · quota balance not yet reported'
      : 'No active Start Plan promotion · Coding Plan is separate', windows: [] };
  return { granted, ...(boundaries.length ? { validUntil } : {}), ...(modelIds.length ? { entitlement: { modelIds, validUntil } } : {}), usage };
}
export function startEntitlement(value: unknown, nativeIds: string[], now = Date.now(), serverDate?: number): StartEntitlement {
  const entitlement = startBalance(value, nativeIds, now, serverDate).entitlement;
  if (!entitlement) throw Error('Start Plan has no entitled native models (missing, expired or exhausted plan).');
  return entitlement;
}
export async function fetchStartBalance(auth: ReadOnlyAuth, appVersion: string, nativeIds: string[], env: NodeJS.ProcessEnv, home = homedir()): Promise<StartBalance> {
  let device: unknown;
  try { device = record(JSON.parse(readFileSync(join(home, '.zcode/v2/telemetry-state.json'), 'utf8'))).deviceMid; } catch { /* Native header is omitted when unavailable. */ }
  const printable = (value: unknown) => typeof value === 'string' && /^[\x20-\x7e]+$/.test(value.trim()) ? value.trim() : undefined;
  const mid = printable(device), locale = Intl.DateTimeFormat().resolvedOptions();
  const headers = { Authorization: `Bearer ${auth.read('start-balance').apiKey}`, 'HTTP-Referer': 'https://zcode.z.ai',
    'User-Agent': `ZCode/${appVersion}`, 'X-Title': 'Z Code@electron', 'X-ZCode-App-Version': appVersion,
    'X-Platform': `${process.platform}-${process.arch}`, 'X-Release-Channel': 'stable',
    'X-Client-Language': printable(locale.locale) ?? 'unknown', 'X-Client-Timezone': printable(locale.timeZone) ?? 'unknown',
    'X-Os-Category': process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    'X-Os-Version': printable(version()) ?? 'unknown', ...(mid ? { 'X-Device-Mid': mid } : {}) };
  let serverDate: number | undefined;
  try {
    const send = tokenRequest(env, date => { const t = Date.parse(date ?? ''); if (Number.isFinite(t)) serverDate = t; });
    const result = await send(`https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(appVersion)}`, 'GET', headers);
    return startBalance(result, nativeIds, Date.now(), serverDate);
  } catch (error) {
    // Preserve fixed local diagnosis; never serialize remote bodies or headers.
    if (error instanceof ProjectTokenError && error.code === 'project_token_login_failed') throw new AuthError('unauthenticated');
    if (error instanceof Error && error.message.startsWith('Start Plan')) throw error;
    throw Error('Start Plan balance unavailable or sign-in rejected; check Desktop sign-in and retry an independent operation.');
  }
}
export async function fetchStartEntitlement(...args: Parameters<typeof fetchStartBalance>): Promise<StartEntitlement> {
  try {
    const result = await fetchStartBalance(...args);
    if (!result.entitlement) throw Error('Start Plan has no entitled native models (missing, expired or exhausted plan).');
    return result.entitlement;
  } catch (error) {
    if (error instanceof AuthError) throw Error('Start Plan balance unavailable or sign-in rejected; check Desktop sign-in and retry an independent operation.');
    throw error;
  }
}
