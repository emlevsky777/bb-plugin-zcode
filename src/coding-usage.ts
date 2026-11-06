// Personal Z.ai quota semantics from installed Desktop 3.17.2 (Apache-2.0).
import { ReadOnlyAuth, authMode } from './auth.ts';
import { record } from './errors.ts';
import { fileIdentity } from './compatibility.ts';
import { readDiscovery, discoveryScope } from './discovery-cache.ts';
import { tokenRequest } from './project-token.ts';
import type { TokenRequest } from './project-token.ts';
import { providerUsageSchema } from '@get-bb/plugin-sdk/provider-bridge';
import type { ProviderUsage } from '@get-bb/plugin-sdk/provider-bridge';

export type CodingMeasurement = { observedAt: number | null; usage: ProviderUsage };
const authSources = new Map<string, ReadOnlyAuth>();
const failed = (): ProviderUsage => ({ status: 'error', accountEmail: null, planLabel: 'Coding Plan', message: 'Coding Plan usage unavailable; check the selected sign-in source and retry refresh.' });
function data(value: unknown): unknown {
  const e = record(value);
  if (e.success === false || e.code !== undefined && e.code !== 0 && e.code !== 200 || e.data === undefined) throw Error('Coding response unavailable');
  return e.data;
}
export function codingSubscription(value: unknown): 'active' | 'absent' | 'expired' | 'unknown' {
  const rows = data(value); if (!Array.isArray(rows)) return 'unknown';
  let expired = false, unknown = false;
  for (const value of rows) {
    const r = record(value);
    if (![r.productId, r.productName].some(v => typeof v === 'string' && /coding/i.test(v))) continue;
    if (typeof r.status !== 'string' || typeof r.inCurrentPeriod !== 'boolean') { unknown = true; continue; }
    if (r.status === 'VALID' && r.inCurrentPeriod) return 'active';
    expired ||= r.status === 'EXPIRED';
  }
  return unknown ? 'unknown' : expired ? 'expired' : 'absent';
}
export function codingQuota(value: unknown): ProviderUsage {
  const quota = record(data(value));
  if (!Array.isArray(quota.limits)) return failed();
  const windows: { label: string; usedPercent: number; resetsAt: string | null }[] = [];
  const seen = new Set<string>();
  for (const value of quota.limits) {
    const r = record(value), model = r.type === 'TOKENS_LIMIT' || r.type === 'CREDIT_LIMIT';
    const label = model && r.unit === 3 && r.number === 5 ? 'Coding Plan · 5-hour model quota'
      : model && r.unit === 6 ? 'Coding Plan · Weekly model quota'
      : r.type === 'TIME_LIMIT' && r.unit === 5 && r.number === 1 ? 'Coding Plan · Monthly MCP / tools' : undefined;
    if (!label || seen.has(label)) continue;
    // number is the window duration, never an amount denominator.
    if (typeof r.percentage !== 'number' || !Number.isFinite(r.percentage) || r.percentage < 0 || r.percentage > 100) return failed();
    const reset = typeof r.nextResetTime === 'number' && Number.isFinite(r.nextResetTime) && r.nextResetTime > 0 ? new Date(r.nextResetTime) : null;
    if (reset && Number.isNaN(reset.getTime())) return failed();
    windows.push({ label, usedPercent: r.percentage, resetsAt: reset?.toISOString() ?? null }); seen.add(label);
  }
  return windows.length ? { status: 'ok', accountEmail: null, planLabel: 'Coding Plan', windows } : failed();
}
function decode(value: unknown): CodingMeasurement {
  const r = record(value);
  if (r.observedAt !== null && (!Number.isSafeInteger(r.observedAt) || Number(r.observedAt) < 0)) throw Error('Invalid Coding snapshot');
  return { observedAt: r.observedAt as number | null, usage: providerUsageSchema.parse(r.usage) };
}
export async function collectCodingUsage(options: {
  root: string; version: string; mode?: unknown; keyPath?: string; auth?: ReadOnlyAuth;
  env?: NodeJS.ProcessEnv; send?: TokenRequest; beforeRead?: (endpoint: string) => void;
}): Promise<CodingMeasurement> {
  const env = options.env ?? process.env, mode = authMode(options.mode);
  const authKey = JSON.stringify([options.root, mode, options.keyPath, options.version, env.ZCODE_HTTP_PROXY, env.HTTPS_PROXY, env.ZCODE_AGENT_CA_CERT]);
  let auth = options.auth ?? authSources.get(authKey);
  if (!auth) {
    auth = new ReadOnlyAuth().fork(mode, options.keyPath);
    auth.setNetworkEnvironment(env, options.version); authSources.set(authKey, auth);
  }
  if (options.auth) auth.setNetworkEnvironment(env, options.version);
  if (options.send) auth.setTokenRequest(options.send);
  const selectedAuth = auth;
  const scope = () => discoveryScope(JSON.stringify({ semantics: 'personal-zai-usage-v1', mode, version: options.version,
    source: fileIdentity(mode === 'desktop' ? [auth.path] : options.keyPath ? [options.keyPath] : []) }));
  const initial = scope();
  try {
    auth.read('coding-usage-validation');
    return await readDiscovery(options.root, 'coding-usage', initial, 60_000, async () => {
      const material = () => {
        const { apiKey, oauth } = selectedAuth.read('coding-usage-scope');
        return JSON.stringify({ apiKey, oauth });
      };
      const sourceMaterial = material();
      const authorization = await selectedAuth.usageAuthorization(), send = options.send ?? tokenRequest(env);
      const current = () => {
        // Recheck the source, not expiring project-token material. Resolving
        // that token here could mint another token after an otherwise valid GET.
        if (scope() !== initial || material() !== sourceMaterial) throw Error('Coding source changed');
      };
      let subscription: ReturnType<typeof codingSubscription> = 'unknown';
      try {
        options.beforeRead?.('subscription/list');
        subscription = codingSubscription(await send('https://api.z.ai/api/biz/subscription/list', 'GET', { authorization }));
      } catch { /* Subscription failure is unknown, never absence. */ }
      current();
      if (subscription === 'absent' || subscription === 'expired') return { observedAt: Date.now(), usage: {
        status: 'ok' as const, accountEmail: null, planLabel: subscription === 'expired' ? 'Coding Plan · No current subscription (expired)' : 'Coding Plan · No active subscription', windows: [] } };
      options.beforeRead?.('quota/limit');
      let usage: ProviderUsage;
      try { usage = codingQuota(await send('https://api.z.ai/api/monitor/usage/quota/limit', 'GET', { authorization })); }
      catch { usage = failed(); }
      current();
      if (usage.status !== 'ok') throw Error('Coding usage unavailable');
      return { observedAt: Date.now(), usage };
    }, decode, () => Infinity, () => scope() === initial, 30_000);
  } catch { return { observedAt: null, usage: failed() }; }
}
