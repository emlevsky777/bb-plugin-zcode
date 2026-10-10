import type { ThreadDelta } from '@get-bb/plugin-sdk/provider-bridge';
import { signInHint } from './applications.ts';

type ServiceError = Extract<ThreadDelta, { kind: 'provider.error' }>;
type Category = NonNullable<ServiceError['category']>;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const code = (v: unknown): string | null => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(v) ? v : null;
const billing = new Set(['1113', '1309', '1311', 'insufficient_quota', 'credit_balance_exhausted', 'exceeded_current_quota_error']);
const budget = new Set(['organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded']);
// Pinned native business-code table. New codes stay unknown even when native
// infers a generic HTTP reason (e.g. invalid_request for any HTTP 400).
const knownBusiness = new Set(['500', '1005', '1006', '1008', '1113', '1120', '1230', '1234', '1261',
  '1302', '1303', '1304', '1305', '1308', '1309', '1310', '1311', '1312', '1313', '1314', '1315',
  '1316', '1317', '1318', '1319', '1320', '1321', '2007', '2056', '20097',
  '3001', '3002', '3006', '3007', '3008', '3009', '3010',
  ...billing, ...budget, 'rate_limit_reached_error', 'rate_limit_error', 'engine_overloaded_error', 'overloaded_error']);
const reasons: Record<string, Category> = Object.assign(Object.create(null), {
  rate_limited: 'rate-limit', provider_overloaded: 'overloaded', context_exceeded: 'context-window-exceeded',
  auth_failed: 'unauthorized', provider_not_configured: 'unauthorized', network_error: 'connection-failed',
  timeout: 'connection-failed', proxy_error: 'connection-failed', tls_error: 'connection-failed',
  stream_idle_timeout: 'stream-disconnected', stale_connection: 'stream-disconnected',
  server_error: 'internal', invalid_request: 'bad-request',
});
const nativeCodes: Record<string, Category> = Object.assign(Object.create(null), {
  model_rate_limited: 'rate-limit', model_context_exceeded: 'context-window-exceeded',
  model_request_auth_missing: 'unauthorized', provider_not_configured: 'unauthorized',
  model_request_timeout: 'connection-failed', model_timeout: 'connection-failed', invalid_model_request: 'bad-request',
});
const messages: Partial<Record<Category, string>> = {
  'rate-limit': 'Z.ai request limit reached. Wait for your limit to reset, then retry.',
  overloaded: 'Z.ai is overloaded. bb will schedule a retry if automatic provider retry is enabled.',
  'context-window-exceeded': 'The Z.ai context window is full. Compact the conversation or start a new thread.',
  billing: 'Z.ai credit or balance is exhausted. Check your Z.ai account and billing before retrying.',
  'budget-exceeded': 'The Z.ai spending or usage budget is exhausted. Check your account budget before retrying.',
  unauthorized: `Z.ai authentication failed. ${signInHint()}`,
  'connection-failed': 'Could not connect to Z.ai. Check your network connection, then retry.',
  'stream-disconnected': 'The Z.ai response stream disconnected. Check your connection, then retry.',
  internal: 'Z.ai encountered a server error. Wait briefly, then retry.',
  'bad-request': 'Z.ai rejected the request. Check the selected model and request settings before retrying.',
};

// Never forward raw native messages/details: they can contain prompts or credentials.
export function serviceError(value: unknown): ServiceError | undefined {
  const error = object(value);
  if (!Object.keys(error).length) return;
  const attribution = object(error.attribution);
  const businessCode = code(attribution.providerErrorCode);
  const providerCode = businessCode ?? code(error.code);
  const reason = code(attribution.reason);
  const nativeCode = code(error.code);
  const category: Category = businessCode && !knownBusiness.has(businessCode) ? 'unknown'
    : providerCode && billing.has(providerCode) ? 'billing'
    : providerCode && budget.has(providerCode) ? 'budget-exceeded'
    : (reason ? reasons[reason] : undefined) ?? (nativeCode ? nativeCodes[nativeCode] : undefined) ?? 'unknown';
  const status = attribution.statusCode;
  const httpStatusCode = Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? Number(status) : null;
  const label = providerCode ? ` (code: ${providerCode})` : '';
  return { kind: 'provider.error', category, errorInfo: { category, providerCode, httpStatusCode },
    message: (messages[category] ?? 'Z.ai request failed. Check your Z.ai account and retry; contact support if it persists.') + label };
}
