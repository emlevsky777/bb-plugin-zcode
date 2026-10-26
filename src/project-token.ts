// Adapted from installed ZCode Desktop 3.15.1 resolveProviderMaterial and
// ProjectAccessTokenClient/Cache (Apache-2.0). See the dated semantic record.
// Only individual Z.ai OAuth is used. No credential/configuration writes.
import { Agent, request } from 'node:https';
import { rootCertificates } from 'node:tls';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { record, string } from './errors.ts';

export class ProjectTokenError extends Error {
  readonly code: string;
  readonly transient: boolean;
  constructor(code: string, transient = false) { super(code); this.code = code; this.transient = transient; }
}
export type TokenRequest = (path: string, method: 'GET' | 'POST', headers: Record<string, string>, body?: unknown) => Promise<unknown>;
export function tokenRequest(env: NodeJS.ProcessEnv): TokenRequest {
  return (path, method, headers, body) => new Promise((resolve, reject) => {
    const ca = env.ZCODE_AGENT_CA_CERT;
    const agent = new Agent({ proxyEnv: { ...env, ...(env.ZCODE_HTTP_PROXY ? { HTTPS_PROXY: env.ZCODE_HTTP_PROXY, https_proxy: env.ZCODE_HTTP_PROXY } : {}) },
      ...(ca ? { ca: [...rootCertificates, readFileSync(ca, 'utf8')] } : {}) });
    const req = request(new URL(path, 'https://api.z.ai'), { agent, method, headers, signal: AbortSignal.timeout(15000) }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        if (status === 404) { resolve({ code: 404 }); return; }
        if (status < 200 || status >= 300) { reject(new ProjectTokenError(status === 401 ? 'project_token_login_failed' : 'project_token_request_failed', status === 429 || status >= 500)); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new ProjectTokenError('project_token_invalid_response')); }
      });
    });
    req.on('error', error => reject(error instanceof ProjectTokenError ? error : new ProjectTokenError('project_token_request_failed', true)));
    req.on('close', () => agent.destroy());
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function data(value: unknown): unknown {
  const row = record(value);
  if (row.code === 401 || row.code === '401') throw new ProjectTokenError('project_token_login_failed');
  if (![0, 200, '0', '200'].includes(row.code as number | string)) throw new ProjectTokenError('project_token_invalid_response');
  return row.data;
}
export interface ProjectTokenMaterial { apiKey: string; apiKeyId: string; accountScope: string }
export class ProjectTokenResolver {
  private state: { scope: string; value?: ProjectTokenMaterial; expiresAt?: number; refreshAt?: number; pending?: Promise<ProjectTokenMaterial> } | undefined;
  private send: TokenRequest;
  private now: () => number;
  private random: () => number;
  private clientVersion: string;
  constructor(send: TokenRequest, now = Date.now, random = Math.random, clientVersion = 'unknown') { this.send = send; this.now = now; this.random = random; this.clientVersion = clientVersion; }
  clear() { this.state = undefined; }
  async resolve(identity: string, oauth: string, params: Record<string, unknown>, stillCurrent: () => boolean): Promise<ProjectTokenMaterial> {
    oauth = oauth.trim().replace(/^Bearer\s+/i, '');
    const scope = sha(JSON.stringify(['account:zai-individual-coding-plan', 'zai', identity, oauth]));
    if ((params.expectedAccountScope && params.expectedAccountScope !== scope) || (params.rejectedProjectTokenFingerprint && !params.expectedAccountScope))
      throw new ProjectTokenError('project_token_scope_invalidated');
    if (this.state?.scope !== scope) this.state = { scope };
    const state = this.state;
    const current = () => {
      if (this.state !== state || !stillCurrent()) throw new ProjectTokenError('project_token_scope_invalidated');
    };
    current();
    if (params.rejectedProjectTokenFingerprint === (state.value && sha(state.value.apiKey))) { delete state.value; delete state.refreshAt; }
    if (state.pending) return state.pending;
    if (state.value && this.now() < Math.min(state.refreshAt!, state.expiresAt!)) return state.value;
    const pending = this.load(oauth, scope, current).then(result => {
      current(); state.value = result.value; state.expiresAt = result.expiresAt;
      state.refreshAt = result.expiresAt - 120000 - Math.max(0, Math.min(1, this.random())) * 60000;
      return result.value;
    }).catch(error => {
      current();
      if (error instanceof ProjectTokenError && error.transient && state.value && this.now() < state.expiresAt!) {
        state.refreshAt = Math.min(this.now() + 5000, state.expiresAt!); return state.value;
      }
      this.state = undefined; throw error;
    }).finally(() => { if (state.pending === pending) delete state.pending; });
    state.pending = pending; return pending;
  }
  private async load(oauth: string, accountScope: string, current: () => void) {
    const json = { 'Content-Type': 'application/json' };
    const send = async (path: string, method: 'GET' | 'POST', headers: Record<string, string>, body?: unknown) => {
      current(); const result = await this.send(path, method, headers, body); current(); return result;
    };
    // Desktop stores the normalized business token, not the upstream OAuth
    // token expected by the standalone CLI's /api/auth/z/login wrapper.
    const headers = { ...json, Authorization: `Bearer ${oauth}` };
    const customer = record(data(await send('/api/biz/customer/getCustomerInfo', 'GET', headers)));
    const organizations = (Array.isArray(customer.organizations) ? customer.organizations.map(record) : [])
      .map(o => ({ ...o, organizationId: o.organizationId, organizationName: o.organizationName,
        projects: (Array.isArray(o.projects) ? o.projects.map(record) : [])
        .filter(p => String(p.projectType ?? '').trim() !== '2') }))
      .filter(o => o.organizationId && o.projects.length);
    const organization = organizations.find(o => String(o.organizationName ?? '').includes('默认机构')) ?? organizations[0];
    const projects = organization && Array.isArray(organization.projects) ? organization.projects.map(record) : [];
    const project = projects.find(p => String(p.projectName ?? '').includes('默认项目')) ?? projects[0];
    if (!organization?.organizationId || !project?.projectId) throw new ProjectTokenError('project_token_project_unavailable');
    const path = `/api/biz/v1/organization/${encodeURIComponent(string(organization.organizationId))}/projects/${encodeURIComponent(string(project.projectId))}/api_keys`;
    const keys = data(await send(path, 'GET', headers));
    if (!Array.isArray(keys)) throw new ProjectTokenError('project_token_invalid_response');
    const key = record(keys.find(k => record(k).name === 'zcode-api-key') ?? data(await send(path, 'POST', headers, { name: 'zcode-api-key', usageScene: 1 })));
    const apiKeyId = string(key.apiKey).trim();
    if (!apiKeyId) throw new ProjectTokenError('project_token_invalid_response');
    const started = this.now();
    const token = record(data(await send(`${path}/${encodeURIComponent(apiKeyId)}/access_tokens`, 'POST', headers, { clientType: 'zcode', clientVersion: this.clientVersion })));
    if (token.enable === false) throw new ProjectTokenError('project_token_disabled');
    if ((token.enable !== undefined && token.enable !== true) ||
      typeof token.expiresAt !== 'number' || !Number.isFinite(token.expiresAt) || token.expiresAt <= 0 ||
      typeof token.expiresIn !== 'number' || !Number.isFinite(token.expiresIn) || token.expiresIn <= 0)
      throw new ProjectTokenError('project_token_invalid_response');
    const apiKey = typeof token.accessToken === 'string' ? token.accessToken.trim() : '';
    const expiresAt = Math.min(Number(token.expiresAt) * 1000, started + Number(token.expiresIn) * 1000);
    if (!apiKey || token.tokenType !== 'Bearer' || !Number.isFinite(expiresAt) || expiresAt <= this.now()) throw new ProjectTokenError('project_token_invalid_response');
    return { value: { apiKey, apiKeyId, accountScope }, expiresAt };
  }
}
