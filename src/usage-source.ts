// Installed bb 0.48.1 provider-usage.v1 protocol, as used by builtin Codex.
// Only public SDK calls; no account identity is inferred from credentials.
import { defineRpcContract } from '@get-bb/plugin-sdk';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { providerUsageSchema } from '@get-bb/plugin-sdk/provider-bridge';
import { record } from './errors.ts';

const text = { type: 'string', minLength: 1 }, nullableText = { anyOf: [text, { type: 'null' }] };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required });
// Standard JSON Schema export is required for discoverable RPC in bb 0.48.1.
// Keep validation and publication here; no additional schema dependency.
function schema<T>(json: Record<string, unknown>, decode: (value: unknown) => T) {
  return { '~standard': { version: 1 as const, vendor: 'zcode', jsonSchema: { input: () => json, output: () => json },
    validate(value: unknown) { try { return { value: decode(value) }; } catch { return { issues: [{ message: 'Invalid Start usage resource' }] }; } } } };
}
type Resource = { id: string; accountKey: null; providerId: string; label: string; scope: { kind: 'host'; hostId: string; hostName: string } };
type Measurement = { accountKey: null; observedAt: number | null; usage: Record<string, unknown> };
const nonempty = (v: unknown): string => { if (typeof v !== 'string' || !v.trim()) throw Error(); return v; };
const scopeJson = object({ kind: { const: 'host' }, hostId: text, hostName: text });
const inventory = schema<{ resources: Resource[] }>(object({ resources: { type: 'array', items: object({ id: text, accountKey: { type: 'null' }, providerId: text, label: text, scope: scopeJson }) } }), value => {
  const r = record(value); if (!Array.isArray(r.resources)) throw Error();
  return { resources: r.resources.map(value => { const r = record(value), s = record(r.scope); if (r.accountKey !== null || s.kind !== 'host') throw Error();
    return { id: nonempty(r.id), accountKey: null, providerId: nonempty(r.providerId), label: nonempty(r.label), scope: { kind: 'host', hostId: nonempty(s.hostId), hostName: nonempty(s.hostName) } }; }) };
});
const windowJson = object({ id: text, kind: { const: 'custom' }, model: { type: 'null' }, label: text, usedPercent: { type: 'number', minimum: 0 }, resetsAt: nullableText, cost: { type: 'null' } });
const baseUsage = { plan: { type: 'null' }, accountEmail: nullableText, planLabel: nullableText };
const measurement = schema<Measurement>(object({ accountKey: { type: 'null' }, observedAt: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
  usage: { oneOf: ['ok', 'not_installed', 'unauthenticated', 'expired', 'error'].map(status => object({ status: { const: status }, ...baseUsage,
    ...(status === 'ok' ? { windows: { type: 'array', items: windowJson } } : status === 'error' ? { message: text } : {}) })) } }), value => {
  const r = record(value), u = record(r.usage);
  if (r.accountKey !== null || r.observedAt !== null && (!Number.isSafeInteger(r.observedAt) || Number(r.observedAt) < 0) || u.plan !== null) throw Error();
  const windows = Array.isArray(u.windows) ? u.windows.map(value => { const w = record(value);
    if (w.cost !== null || w.kind !== 'custom' || w.model !== null) throw Error(); nonempty(w.id);
    const { cost: _, ...bridgeWindow } = w; return bridgeWindow;
  }) : undefined;
  providerUsageSchema.parse({ ...u, ...(windows ? { windows } : {}) });
  return { accountKey: null, observedAt: r.observedAt as number | null, usage: u };
});
export const codingHostContract = defineRpcContract({ codingUsage: {
  input: schema<{ mode: 'desktop' | 'coding-plan-key' }>(object({ mode: { enum: ['desktop', 'coding-plan-key'] } }), value => {
    const r = record(value); if (r.mode !== 'desktop' && r.mode !== 'coding-plan-key') throw Error(); return { mode: r.mode };
  }), output: measurement,
} });
export function usageMeasurement(usage: Record<string, unknown>, observedAt: number | null): Measurement {
  return { accountKey: null, observedAt, usage: { accountEmail: null, planLabel: 'Coding Plan', ...usage, plan: null,
    ...(usage.status === 'ok' ? { windows: (usage.windows as Record<string, unknown>[]).map((w, i) => ({ ...w, id: `${i}:${w.label}`, kind: 'custom', model: null, cost: null })) } : {}) } };
}
export const usageList = 'provider-usage.v1.listResources', usageGet = 'provider-usage.v1.getResource';
export const usageSourceContract = defineRpcContract({
  [usageList]: { input: schema<Record<string, never>>(object({}), value => { if (Object.keys(record(value)).length) throw Error(); return {}; }), output: inventory },
  [usageGet]: { input: schema<{ resourceId: string; refresh: boolean }>(object({ resourceId: text, refresh: { type: 'boolean' } }), value => { const r = record(value); if (typeof r.refresh !== 'boolean') throw Error(); return { resourceId: nonempty(r.resourceId), refresh: r.refresh }; }), output: measurement },
});
export function registerUsageSource(bb: BbPluginApi, providerId: string, mode: () => Promise<'desktop' | 'coding-plan-key'> = async () => 'desktop') {
  const observed = new Map<string, number>();
  const hostClient = bb.hosts?.experimental_client({ contract: codingHostContract });
  async function resources(): Promise<Resource[]> {
    const result: Resource[] = [];
    for (const host of await bb.sdk.hosts.list()) {
      const providers = await bb.sdk.providers.list({ hostId: host.id, capability: 'usage' });
      if (providers.some(p => p.id === providerId && p.pluginId === bb.pluginId)) for (const plan of ['coding', 'start']) result.push({ id: JSON.stringify([host.id, providerId, plan]), accountKey: null,
        providerId, label: plan === 'coding' ? 'Coding Plan' : 'Start Plan', scope: { kind: 'host', hostId: host.id, hostName: host.name } });
    }
    return result;
  }
  bb.rpc.register(usageSourceContract, {
    [usageList]: async () => ({ resources: await resources() }),
    [usageGet]: async input => {
      const r = record(input), resourceId = nonempty(r.resourceId), refresh = r.refresh === true;
      const resource = (await resources()).find(r => r.id === resourceId);
      if (!resource) throw Error('Usage resource no longer exists.');
      if (resource.label === 'Coding Plan') {
        try {
          if (!hostClient) throw Error('Host client unavailable');
          const decoded = measurement['~standard'].validate(await hostClient.call('codingUsage', { mode: await mode() }, { hostId: resource.scope.hostId, timeoutMs: 120_000 }));
          if (!('value' in decoded) || !decoded.value) throw Error('Invalid host usage');
          const value = decoded.value;
          if (record(value.usage).status === 'ok' && value.observedAt !== null) observed.set(resourceId, value.observedAt);
          return { ...value, observedAt: observed.get(resourceId) ?? null };
        } catch { return usageMeasurement({ status: 'error', message: 'Coding Plan usage could not be collected from this machine.' }, observed.get(resourceId) ?? null); }
      }
      let usage;
      try { usage = (await bb.sdk.system.usageLimits({ hostId: resource.scope.hostId, providerId, refresh }))[providerId]; }
      catch { /* Fixed failure below, never a remote error body. */ }
      const checked = providerUsageSchema.parse(usage ?? { status: 'error', message: 'Start usage could not be collected from this machine.', accountEmail: null, planLabel: 'Start Plan' });
      if (checked.status === 'ok') observed.set(resourceId, Date.now());
      return { accountKey: null, observedAt: observed.get(resourceId) ?? null, usage: { ...Object.assign({ accountEmail: null, planLabel: 'Start Plan' }, checked), plan: null,
        ...(checked.status === 'ok' ? { windows: checked.windows.map((w, i) => ({ ...w, id: `${i}:${w.label}`, kind: 'custom', model: null, cost: null })) } : {}) } };
    },
  }, { experimental_discoverable: true, experimental_description: 'Independent host-local Coding Plan and Start Plan quota; inventory reads metadata only.' });
}
