// Read-only projection of Desktop 3.17.2 marketing claim deliveries.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ReadOnlyAuth } from './auth.ts';
import { record } from './errors.ts';
import { tokenRequest } from './project-token.ts';
export type StartOffer = { offers: { campaignId: string; planId: string; position: 'banner' | 'popup' }[] };
const id = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 128;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bounded = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const text = (v: unknown, banner = false) => obj(v) && ['plaintext', 'html', 'markdown', ...(banner ? [''] : [])].includes(String(v.format)) && bounded(v.content, 20_000);
const url = (v: unknown) => {
  if (!bounded(v, 4096)) return false;
  try { const u = new URL(v as string); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
};
const asset = (v: unknown) => obj(v) && url(v.src) && typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.sha256);
function visual(v: unknown): boolean {
  if (!obj(v) || v.args !== undefined && (!obj(v.args) || JSON.stringify(v.args).length > 64_000)) return false;
  if (v.type === 'image') return obj(v.image) && asset(v.image.default) && (v.image.dark == null || asset(v.image.dark));
  if (v.type === 'video') return obj(v.video) && asset(v.video.src) && asset(v.video.fallback);
  return v.type === 'bundle' && obj(v.bundle) && asset(v.bundle.bundle) && typeof v.bundle.entry === 'string' &&
    v.bundle.entry.length > 0 && v.bundle.entry.length <= 240 && !v.bundle.entry.includes('\\') && v.bundle.entry.split('/').every(p => p && p !== '.' && p !== '..') &&
    (v.bundle.fallback == null || asset(v.bundle.fallback));
}
function action(v: unknown): boolean {
  if (!obj(v)) return false;
  if (v.type === 'close') return true;
  if (!obj(v.args)) return false;
  if (v.type === 'claim_zcode_plan') return id(v.args.plan_id);
  if (v.type === 'open_url') return url(v.args.url);
  if (v.type === 'copy_text') return Object.keys(v.args).length === 1 && bounded(v.args.text, 20_000) && String(v.args.text).trim().length > 0;
  if (v.type !== 'navigate') return false;
  const a = v.args;
  if (['upgrade', 'rewards'].includes(String(a.page))) return Object.keys(a).length === 1;
  if (a.page === 'plugin_marketplace') return Object.keys(a).every(k => ['page', 'plugin_id'].includes(k)) && (a.plugin_id === undefined || id(a.plugin_id) && /^[^@\s]+@[^@\s]+$/.test(a.plugin_id));
  return a.page === 'settings' && Object.keys(a).every(k => ['page', 'section', 'provider_id'].includes(k)) &&
    (a.section === undefined || ['general', 'appearance', 'models', 'browser', 'computer_use', 'memory', 'subagents', 'plugins', 'mcp', 'skills', 'commands', 'hooks', 'usage'].includes(String(a.section))) &&
    (a.provider_id === undefined || id(a.provider_id) && a.section === 'models');
}
function button(v: unknown, banner: boolean): boolean {
  if (!obj(v) || !text(v.text, banner) || !action(v.action)) return false;
  const t = v.theme;
  return banner || t == null || obj(t) && (t.variant === undefined || ['', 'default', 'outline', 'secondary', 'ghost', 'destructive', 'warning', 'link'].includes(String(t.variant))) &&
    (t.class === undefined || bounded(t.class, 512)) && (t.style === undefined || bounded(t.style, 512));
}
function card(v: unknown, banner: boolean): v is Record<string, unknown> & { buttons: Record<string, unknown>[] } {
  if (!obj(v) || v.layout !== undefined && !['', 'v1'].includes(String(v.layout)) || !Array.isArray(v.buttons) || v.buttons.length > (banner ? 2 : 4) || !v.buttons.every(b => button(b, banner))) return false;
  if (!banner) return text(v.title) && text(v.description) && (v.hero == null || visual(v.hero));
  return visual(v.background) && (v.success_popup == null || card(v.success_popup, false)) &&
    v.buttons.filter(b => record(b.action).type === 'close').length <= 1 && v.buttons.filter(b => record(b.action).type !== 'close').length <= 1;
}
export function startOffer(value: unknown): StartOffer {
  const v = record(value);
  if (!Array.isArray(v.offers) || !v.offers.every(o => obj(o) && id(o.campaignId) && id(o.planId) && ['banner', 'popup'].includes(String(o.position)))) throw Error('Invalid Start offer snapshot');
  return { offers: v.offers.map(o => ({ campaignId: o.campaignId, planId: o.planId, position: o.position })) };
}
export function marketingStartOffer(value: unknown): StartOffer {
  const v = record(value), d = record(v.data);
  if (v.code !== 0 || !Number.isFinite(d.server_time) || !['zh-CN', 'en-US'].includes(String(d.language)) || !Array.isArray(d.deliveries) || d.deliveries.length > 32) throw Error('Start claim discovery unavailable');
  const seen = new Set<string>(), offers: StartOffer['offers'] = [];
  for (const raw of d.deliveries) {
    if (!obj(raw) || !id(raw.campaign_id) || !Number.isInteger(raw.priority) || Number(raw.priority) < 0 || Number(raw.priority) > 100) continue;
    const position = raw.resource_position;
    if (position !== 'banner' && position !== 'popup' || seen.has(position)) continue;
    const c = raw[position]; if (!card(c, position === 'banner')) continue;
    seen.add(position);
    for (const b of c.buttons) {
      const a = record(b.action);
      if (a.type === 'claim_zcode_plan') offers.push({ campaignId: raw.campaign_id.trim(), planId: String(record(a.args).plan_id).trim(), position });
    }
  }
  return { offers };
}
export function startOfferContext(appVersion: string, env: NodeJS.ProcessEnv, home = homedir()) {
  const test = env.ZCODE_ENV?.trim().toLowerCase() === 'test', nonempty = (v: string | undefined) => v?.trim() || undefined;
  const endpoint = new URL(nonempty(env.ZCODE_BASE_URL) ?? nonempty(env.ZCODE_ENDPOINT_ORIGIN) ?? nonempty(env[test ? 'ZCODE_TEST_BASE_URL' : 'ZCODE_PRODUCTION_BASE_URL']) ?? (test ? 'https://zcode.chatglm.site' : 'https://zcode.z.ai'));
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw Error('ZCode endpoint origin must use http or https');
  const origin = endpoint.origin;
  const device = record(JSON.parse(readFileSync(join(home, '.zcode/v2/telemetry-state.json'), 'utf8'))).deviceMid;
  if (typeof device !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(device)) throw Error('Start claim discovery requires the existing Desktop device identity');
  return { origin, appVersion, device, language: 'en-US' as const };
}
let sequence = 0;
export async function fetchStartOffer(auth: ReadOnlyAuth, appVersion: string, env: NodeJS.ProcessEnv, home = homedir()): Promise<StartOffer> {
  try {
    const c = startOfferContext(appVersion, env, home), token = auth.read('start-offer').apiKey,
      u = new URL('/api/v1/marketing/touch', c.origin);
    u.searchParams.set('seq', String(sequence++));
    const value = await tokenRequest(env)(u.href, 'GET', { Authorization: `Bearer ${token}`, 'X-Device-Mid': c.device, 'X-Client-Language': c.language, 'X-ZCode-App-Version': appVersion });
    if (auth.read('start-offer-response').apiKey !== token) throw Error('Start offer scope changed');
    return marketingStartOffer(value);
  } catch { throw Error('Start claim discovery unavailable; check ZCode Desktop for current offers.'); }
}
export function startClaimGuidance(offer: StartOffer): string | null {
  return offer.offers.length ? 'ZCode Desktop returned a Start claim offer. Open ZCode Desktop, update it if needed, review your eligibility and claim there. Then refresh the bb model catalogue (discovery may take up to one minute). This offer does not confirm granted quota; Coding Plan is separate.' : null;
}
