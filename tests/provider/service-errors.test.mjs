import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { api, snapshot, inputs } from './helpers.mjs';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/service-errors.json', import.meta.url), 'utf8')).fixtures;
const header = { rowId: 1, kind: 'turnHeader', turnId: 'turn1', state: 'failed', sourceCommandId: 'cmd1' };
const state = (lastError, retry = null, phase = 'error', h = header) => ({ ...snapshot([h]),
  control: { phase, activeWorks: [], apiRetry: retry, lastError }, backgroundWorks: [], pendingInteractions: [] });
test('future native code/reason cannot resolve object prototype entries', () => {
  const t = new api.EventTranslator('session1', 'epoch1', 1, () => {});
  const s = state({ code: 'constructor', attribution: { reason: '__proto__' } });
  const e = t.project(s, 1, inputs(s.rows.window)).find(d => d.kind === 'provider.error');
  assert.equal(e.category, 'unknown'); assert.ok(e.message.includes('constructor'));
});
for (const category of ['rate-limit', 'unauthorized', 'overloaded']) test(`lifecycle sends standard recovery hint for ${category} only when terminal`, () => {
  const messages = [], f = fixtures.find(f => f.category === category);
  const l = new api.SessionLifecycle('thr_2222222222', 'session1', 'epoch1', 1, () => {}, m => messages.push(m), async () => 0);
  const s = state(f.lastError, { attempt: 1, maxAttempts: 3, nextRetryAt: 100, reasonCode: 'rate_limited' });
  l.project(s, 1, 'session1', inputs(s.rows.window));
  assert.equal(messages.filter(m => m.method === 'provider/recovery').length, 0);
  s.control.apiRetry = null; l.project(s, 1, 'session1'); l.project(s, 1, 'session1');
  const hints = messages.filter(m => m.method === 'provider/recovery');
  assert.equal(hints.length, category === 'overloaded' ? 0 : 1);
  if (hints.length) { assert.equal(hints[0].params.kind, category === 'rate-limit' ? 'rateLimited' : 'authRequired'); assert.equal(hints[0].params.retryable, false); }
});
for (const f of fixtures) test(`native service error ${f.category}: one error before boundary, safe text, structured attribution`, () => {
  const t = new api.EventTranslator('session1', 'epoch1', 1, () => {});
  const s = state({ ...f.lastError, message: 'PRIVATE_PROMPT_SECRET', detail: 'PRIVATE_RESPONSE' });
  const ds = t.project(s, 1, inputs(s.rows.window));
  const e = ds.find(d => d.kind === 'provider.error');
  assert.equal(e.category, f.category); assert.equal(e.errorInfo.category, f.category);
  assert.equal(e.errorInfo.providerCode, f.lastError.attribution.providerErrorCode ?? f.lastError.code);
  assert.equal(e.errorInfo.httpStatusCode, f.lastError.attribution.statusCode ?? null);
  assert.ok(e.message.includes(e.errorInfo.providerCode)); assert.ok(!JSON.stringify(ds).includes('PRIVATE'));
  assert.ok(ds.indexOf(e) < ds.findIndex(d => d.kind === 'turn.boundary'));
  assert.equal(ds.filter(d => d.kind === 'provider.error').length, 1);
  assert.deepEqual(t.project(s, 1), []);
});
for (const outcome of ['completedSuccess', 'failed']) test(`apiRetry → ${outcome}: no premature error or boundary, no historical replay`, () => {
  const t = new api.EventTranslator('session1', 'epoch1', 1, () => {}), f = fixtures[0].lastError;
  const retry = state(f, { attempt: 1, maxAttempts: 3, nextRetryAt: 100, reasonCode: 'rate_limited' });
  const ds = t.project(retry, 1, inputs(retry.rows.window));
  assert.equal(ds.filter(d => ['provider.error', 'turn.boundary'].includes(d.kind)).length, 0);
  const final = state(outcome === 'failed' ? f : null, null, outcome === 'failed' ? 'error' : 'completedSuccess', { ...header, state: outcome });
  const end = t.project(final, 1);
  assert.equal(end.filter(d => d.kind === 'provider.error').length, outcome === 'failed' ? 1 : 0);
  assert.equal(end.filter(d => d.kind === 'turn.boundary').length, 1);
  const restored = new api.EventTranslator('session1', 'epoch1', 1, () => {}); restored.restore(t.checkpoint());
  assert.deepEqual(restored.project(final, 1), []);
  assert.deepEqual(t.project(final, 1), []);
});
