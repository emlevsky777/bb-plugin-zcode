// Technical cipher/addressing adapted from zai-org/ZCode 29628c9acdb81b703bbd4080c207a0e7ce5e276e,
// apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts and
// bootstrap/src/app/standalone-account-provider-runtime.ts. Apache-2.0.
// Changes: targeted read-only reads, fixed errors, no backups, no secret cache.
import { createDecipheriv, createHash } from 'node:crypto';
import { homedir, platform, userInfo } from 'node:os';
import { readFileSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { record } from './errors.ts';
import { experimental_BridgeRecoveryError } from '@get-bb/plugin-sdk/provider-bridge';
import { signInHint } from './applications.ts';
import { ProjectTokenResolver, ProjectTokenError, tokenRequest } from './project-token.ts';
import type { TokenRequest } from './project-token.ts';

export const accountProviderId = 'account:zai-individual-coding-plan';
export type AuthMode = 'desktop' | 'coding-plan-key';
export function authMode(value: unknown): AuthMode {
  if (value === undefined || value === 'desktop') return 'desktop';
  if (value === 'coding-plan-key') return value;
  throw new AuthError('unsupported-mode');
}
export class AuthError extends Error {
  readonly kind: 'unauthenticated' | 'invalid-store' | 'unsupported-mode' | 'missing-key';
  constructor(kind: 'unauthenticated' | 'invalid-store' | 'unsupported-mode' | 'missing-key') { super(kind); this.kind = kind; }
}
export class UnsupportedPlanError extends AuthError {
  readonly plan: string;
  constructor(plan: string) {
    super('unsupported-mode');
    this.plan = plan;
    this.message = `${plan} is not supported. This plugin supports only the individual Coding Plan from Z.ai.`;
  }
}
export function unsupportedPlan(value: unknown): string | undefined {
  const p = record(value), access = record(p.accountAccess ?? {}), model = record(p.modelSelection ?? {});
  const providers = [p.providerId, model.providerId].filter(v => typeof v === 'string') as string[];
  const bigmodel = access.accountType === 'bigmodel' || providers.some(v => /^account:bigmodel-/.test(v));
  const mode = access.mode;
  const label = mode === 'start-plan' || providers.some(v => v.endsWith('-start-plan')) ? 'Start Plan'
    : mode === 'team-coding-plan' || providers.some(v => v.endsWith('-team-coding-plan')) ? 'Team Coding Plan'
    : mode === 'off-peak' ? 'off-peak' : bigmodel ? 'individual Coding Plan' : undefined;
  return label ? `${bigmodel ? 'BigModel' : 'Z.ai'} ${label}` : undefined;
}
export function authRecovery(): experimental_BridgeRecoveryError {
  return new experimental_BridgeRecoveryError({ code: -32000, message: 'ZCode requires sign-in',
    recovery: { kind: 'authRequired', message: signInHint(), retryable: false } });
}
export function credentialCipherKey(env = process.env, home = homedir()): Buffer {
  return createHash('sha256').update(env.ZCODE_CREDENTIAL_SECRET ||
    `zcode-credential-fallback:${platform()}:${home}:${userInfo().username}`).digest();
}
function decrypt(value: unknown, key: Buffer): string {
  if (typeof value !== 'string' || !value.trim()) throw new AuthError('invalid-store');
  if (!value.startsWith('enc:v1:')) return value.trim();
  try {
    const parts = value.slice(7).split('.');
    if (parts.length !== 3 || parts.some(p => !p)) throw new Error();
    const [iv, tag, data] = parts.map(p => Buffer.from(p, 'base64url'));
    if (!iv || !tag || !data || iv.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag);
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([cipher.update(data), cipher.final()])).trim();
  } catch { throw new AuthError('invalid-store'); }
}
export class ReadOnlyAuth {
  reads = 0;
  // Counts fresh reads, without storing/comparing values or their hashes.
  generation = 0;
  readonly path: string;
  private key: Buffer;
  private onFresh: (purpose: string, generation: number) => void;
  private mode: AuthMode = 'desktop';
  private explicitKeyPath: string | undefined;
  private projectTokens: ProjectTokenResolver | undefined;
  private network: TokenRequest = tokenRequest(process.env);
  private clientVersion = 'unknown';
  constructor(path = `${homedir()}/.zcode/v2/credentials.json`, key = credentialCipherKey(), onFresh = (_purpose: string, _generation: number) => {}) { this.path = path; this.key = key; this.onFresh = onFresh; }
  fork(mode: AuthMode, explicitKeyPath?: string): ReadOnlyAuth {
    const fresh = new ReadOnlyAuth(this.path, this.key, this.onFresh);
    fresh.explicitKeyPath = explicitKeyPath; fresh.setMode(mode); return fresh;
  }
  setMode(mode: AuthMode): void { this.mode = authMode(mode); this.projectTokens?.clear(); }
  setNetworkEnvironment(env: NodeJS.ProcessEnv, clientVersion: string) { this.network = tokenRequest(env); this.clientVersion = clientVersion; this.projectTokens = undefined; }
  setTokenRequest(send: TokenRequest) { this.network = send; this.projectTokens = undefined; }
  source(): AuthMode { return this.mode; }
  read(purpose = 'read'): { apiKey: string; generation: number; oauth?: { identity: string; accessToken: string } } {
    this.reads++;
    if (this.mode === 'coding-plan-key') {
      if (!this.explicitKeyPath) throw new AuthError('missing-key');
      let fd: number | undefined;
      try {
        fd = openSync(this.explicitKeyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 4096) throw new AuthError('invalid-store');
        const apiKey = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd)).trim();
        if (!apiKey || /[\s\x00-\x1f\x7f]/.test(apiKey)) throw new AuthError('invalid-store');
        this.onFresh(purpose, ++this.generation); return { apiKey, generation: this.generation };
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw new AuthError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-key' : 'invalid-store');
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    let store: Record<string, unknown>;
    try { store = record(JSON.parse(readFileSync(this.path, 'utf8'))); }
    catch (e) { throw new AuthError((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'unauthenticated' : 'invalid-store'); }
    const rawIdentity = store[`account-provider:${accountProviderId}:identity`];
    if (!rawIdentity) {
      for (const provider of ['account:zai-start-plan', 'account:zai-team-coding-plan', 'account:bigmodel-start-plan', 'account:bigmodel-team-coding-plan', 'account:bigmodel-individual-coding-plan'])
        if (store[`account-provider:${provider}:identity`]) throw new UnsupportedPlanError(unsupportedPlan({ providerId: provider })!);
      throw new AuthError('unauthenticated');
    }
    const identity = decrypt(rawIdentity, this.key);
    const source = store[`account-provider:${accountProviderId}:auth-source`];
    const oauth = store['oauth:zai:access_token'];
    if (!source || decrypt(source, this.key) !== 'manual') {
      if (!oauth) throw new AuthError('unauthenticated');
      const accessToken = decrypt(oauth, this.key);
      if (!identity || !accessToken) throw new AuthError('unauthenticated');
      this.onFresh(purpose, ++this.generation);
      return { apiKey: '', generation: this.generation, oauth: { identity, accessToken } };
    }
    const value = store[`account-provider:coding-plan:${accountProviderId}:account:${encodeURIComponent(identity)}:api-key`];
    if (!identity || !value) throw new AuthError('unauthenticated');
    const apiKey = decrypt(value, this.key);
    if (!apiKey) throw new AuthError('unauthenticated');
    this.onFresh(purpose, ++this.generation);
    return { apiKey, generation: this.generation };
  }
  overlay(revision: string, builtin: string): Record<string, unknown> {
    this.read('overlay');
    return { revision, basedOnZCodeBuiltinRevision: builtin,
      providers: { [accountProviderId]: { access: { type: 'zhipu-account', entitled: true } } },
      states: { [accountProviderId]: { availability: 'available', entitled: true, current: true } } };
  }
  private validateHeaders(value: unknown, sessionId: string, workspace: string, selectedModel: string, selectedReasoning: string | undefined, availableModels: readonly string[]): Record<string, unknown> {
    const p = record(value), access = record(p.accountAccess), model = record(p.modelSelection), ws = record(p.workspace);
    const plan = unsupportedPlan(p);
    if (plan) throw new UnsupportedPlanError(plan);
    if (p.providerId !== accountProviderId || access.type !== 'zhipu-account' || access.mode !== 'individual-coding-plan' ||
        access.accountType !== 'zai' || access.entitled !== true || model.providerId !== accountProviderId ||
        !selectedModel || typeof model.modelId !== 'string' || !availableModels.includes(model.modelId) ||
        (model.modelId === selectedModel && model.options !== undefined && selectedReasoning !== undefined && record(model.options).reasoningLevel !== selectedReasoning)) throw new AuthError('unsupported-mode');
    if (p.sessionId !== sessionId || p.reason !== 'model-request' || typeof p.requestId !== 'string' ||
        !p.requestId || ws.workspacePath !== workspace || ws.workspaceKey !== workspace) throw new AuthError('invalid-store');
    return p;
  }
  headers(value: unknown, sessionId: string, workspace: string, selectedModel: string, selectedReasoning?: string, availableModels: readonly string[] = [selectedModel]): Record<string, unknown> {
    this.validateHeaders(value, sessionId, workspace, selectedModel, selectedReasoning, availableModels);
    const fresh = this.read('headers');
    if (fresh.oauth) throw new AuthError('unsupported-mode'); // OAuth uses the async native token flow.
    return { headersApplied: true, requestAuth: { apiKey: fresh.apiKey } };
  }
  async runtimeHeaders(value: unknown, sessionId: string, workspace: string, selectedModel: string, selectedReasoning?: string, availableModels: readonly string[] = [selectedModel]): Promise<Record<string, unknown>> {
    const params = this.validateHeaders(value, sessionId, workspace, selectedModel, selectedReasoning, availableModels);
    const fresh = this.read('headers');
    if (!fresh.oauth) {
      if (params.expectedAccountScope || params.rejectedProjectTokenFingerprint) throw new ProjectTokenError('project_token_scope_invalidated');
      return { headersApplied: true, requestAuth: { apiKey: fresh.apiKey } };
    }
    this.projectTokens ??= new ProjectTokenResolver(this.network, undefined, undefined, this.clientVersion);
    const original = fresh.oauth;
    const material = await this.projectTokens.resolve(original.identity, original.accessToken, params, () => {
      const current = this.read('oauth-scope').oauth;
      return current?.identity === original.identity && current.accessToken === original.accessToken;
    });
    return { headersApplied: true, requestAuth: material };
  }
}
