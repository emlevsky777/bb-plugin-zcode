// Technical cipher/addressing adapted from zai-org/ZCode 29628c9acdb81b703bbd4080c207a0e7ce5e276e,
// apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts and
// bootstrap/src/app/standalone-account-provider-runtime.ts. Apache-2.0.
// Changes: targeted read-only reads, fixed errors, no backups, no secret cache.
import { createDecipheriv, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { homedir, platform, userInfo } from 'node:os';
import { readFileSync, openSync, fstatSync, closeSync, statSync, constants } from 'node:fs';
import { record } from './errors.ts';
import { experimental_BridgeRecoveryError } from '@get-bb/plugin-sdk/provider-bridge';
import { signInHint, resolveZCode } from './applications.ts';
import { ProjectTokenResolver, ProjectTokenError, tokenRequest } from './project-token.ts';
import type { TokenRequest } from './project-token.ts';

export const accountProviderId = 'account:zai-individual-coding-plan';
export type AccountPlan = 'coding-plan' | 'start-plan';
export function accountPlan(value: unknown): AccountPlan {
  if (value === undefined || value === 'coding-plan') return 'coding-plan';
  if (value === 'start-plan') return value;
  throw new AuthError('unsupported-mode');
}
export function nativeAccount(plan: AccountPlan) {
  return plan === 'start-plan'
    ? { id: 'account:zai-start-plan', mode: 'start-plan', route: 'start-plan-gateway', label: 'Start Plan' }
    : { id: accountProviderId, mode: 'individual-coding-plan', route: 'coding-plan-gateway', label: 'Coding Plan' };
}
export function validatePlanSource(plan: AccountPlan, mode: AuthMode) {
  if (plan === 'start-plan' && mode !== 'desktop') throw new Error('Start Plan requires Desktop sign-in; a Coding Plan key cannot authenticate Start Plan.');
}
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
    this.message = `${plan} is unavailable for the selected model's account plan. This plugin supports Z.ai individual Coding Plan and Start Plan; choose a model offered by that plan.`;
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
export class SharedCredentialError extends AuthError {
  constructor() { super('invalid-store'); }
}
export function credentialCipherKey(env = process.env, home = homedir()): Buffer {
  return createHash('sha256').update(env.ZCODE_CREDENTIAL_SECRET ||
    `zcode-credential-fallback:${platform()}:${home}:${userInfo().username}`).digest();
}
// Desktop 4.0.0 createSystemCredentialCipher: same envelope, key addressing
// and AES-GCM semantics, but read-only (no initialization or migration).
export function credentialDecoder(path: string, legacyKey: Buffer, env = process.env,
  readOsKey = () => {
    const bundle = resolveZCode().bundle;
    if (!bundle) throw new AuthError('invalid-store');
    // Use the installed Desktop dependency in place. No bundled copy, helper
    // process, keychain mutation or separate credential/key store.
    const { Entry } = createRequire(import.meta.url)(join(bundle, 'Contents/Resources/app.asar/node_modules/@napi-rs/keyring')) as {
      Entry: new (service: string, account: string) => { getPassword(): string | null };
    };
    return new Entry('ZCode Credential Encryption', createHash('sha256').update(resolve(path)).digest('hex')).getPassword() ?? '';
  }) {
  let material: { key: Buffer; source: string; generation?: string | undefined } | undefined;
  return (value: unknown): string => decrypt(value, legacyKey, () => {
    try {
      const optional = (file: string) => { try { return readFileSync(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; } };
      // Native resolves explicit overrides before reading source/snapshot.
      if (env.ZCODE_CREDENTIAL_SECRET && env.ZCODE_CREDENTIAL_SECRET_FILE) throw new Error();
      const secretFile = (file: string, managed: boolean) => {
        let stat;
        try { stat = statSync(file); }
        catch (e) { if (managed && (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
        if (!stat.isFile() || managed && process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error();
        const secret = readFileSync(file, 'utf8');
        if (Buffer.byteLength(secret) < 32 || Buffer.byteLength(secret) > 4096) throw new Error();
        return secret;
      };
      let secret = env.ZCODE_CREDENTIAL_SECRET || (env.ZCODE_CREDENTIAL_SECRET_FILE ? secretFile(env.ZCODE_CREDENTIAL_SECRET_FILE, false) : undefined);
      if (secret) return { key: createHash('sha256').update(secret).digest(), source: 'env' };
      const generation = optional(`${path}.recovery-generation`);
      const source = optional(join(dirname(path), 'credential-source'));
      if (source !== undefined && source !== 'os\n') throw new Error();
      const snapshot = optional(path) ?? String(value);
      const pinned = source === 'os\n' || snapshot.includes('enc:v2:os:');
      if (!pinned) {
        secret = secretFile(join(dirname(path), 'credential-secret'), true);
        if (secret) return { key: createHash('sha256').update(secret).digest(), source: 'env' };
        if (snapshot.includes('enc:v2:env:')) throw new Error();
      }
      if (material && material.generation === generation && typeof value === 'string' &&
        value.startsWith(`enc:v2:os:${createHash('sha256').update(material.key).digest('hex').slice(0, 24)}:`)) return material;
      const encoded = readOsKey();
      if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error();
      material = { key: Buffer.from(encoded, 'base64url'), source: 'os', generation };
      return material;
    } catch { throw new SharedCredentialError(); }
  });
}
function decrypt(value: unknown, key: Buffer, current?: () => { key: Buffer; source: string }): string {
  if (typeof value !== 'string' || !value.trim()) throw new AuthError('invalid-store');
  if (!value.startsWith('enc:')) return value.trim();
  try {
    let sealed: string;
    if (value.startsWith('enc:v2:')) {
      const envelope = value.slice(7).split(':');
      if (envelope.length !== 3 || !['os', 'env'].includes(envelope[0]!) || !/^[a-f0-9]{24}$/.test(envelope[1]!)) throw new Error();
      const material = current!();
      if (material.source !== envelope[0] || createHash('sha256').update(material.key).digest('hex').slice(0, 24) !== envelope[1]) throw new Error();
      key = material.key; sealed = envelope[2]!;
    } else if (value.startsWith('enc:v1:')) sealed = value.slice(7);
    else throw new Error();
    const parts = sealed.split('.');
    if (parts.length !== 3 || parts.some(p => !p)) throw new Error();
    const [iv, tag, data] = parts.map(p => Buffer.from(p, 'base64url'));
    if (!iv || !tag || !data || iv.length !== 12 || tag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag);
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat([cipher.update(data), cipher.final()])).trim();
  } catch (error) { if (error instanceof SharedCredentialError) throw error; throw new AuthError('invalid-store'); }
}
export class ReadOnlyAuth {
  reads = 0;
  // Counts fresh reads, without storing/comparing values or their hashes.
  generation = 0;
  readonly path: string;
  private key: Buffer;
  private decode: (value: unknown) => string;
  private onFresh: (purpose: string, generation: number) => void;
  private mode: AuthMode = 'desktop';
  private plan: AccountPlan = 'coding-plan';
  private explicitKeyPath: string | undefined;
  private projectTokens: ProjectTokenResolver | undefined;
  private network: TokenRequest = tokenRequest(process.env);
  private clientVersion = 'unknown';
  constructor(path = `${homedir()}/.zcode/v2/credentials.json`, key = credentialCipherKey(), onFresh = (_purpose: string, _generation: number) => {}) { this.path = path; this.key = key; this.onFresh = onFresh; this.decode = credentialDecoder(path, key); }
  fork(mode: AuthMode, explicitKeyPath?: string, plan: AccountPlan = 'coding-plan'): ReadOnlyAuth {
    const fresh = new ReadOnlyAuth(this.path, this.key, this.onFresh);
    fresh.decode = this.decode;
    fresh.explicitKeyPath = explicitKeyPath; fresh.setMode(mode, plan); return fresh;
  }
  setMode(mode: AuthMode, plan: AccountPlan = 'coding-plan'): void { validatePlanSource(plan, mode); this.plan = accountPlan(plan); this.mode = authMode(mode); this.projectTokens?.clear(); }
  setNetworkEnvironment(env: NodeJS.ProcessEnv, clientVersion: string) { this.network = tokenRequest(env); this.clientVersion = clientVersion; this.projectTokens = undefined; }
  setTokenRequest(send: TokenRequest) { this.network = send; this.projectTokens = undefined; }
  source(): AuthMode { return this.mode; }
  accountPlan(): AccountPlan { return this.plan; }
  account() { return nativeAccount(this.plan); }
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
    const decode = this.decode;
    if (this.plan === 'start-plan') {
      if (!store.zcodejwttoken) throw new AuthError('unauthenticated');
      const apiKey = decode(store.zcodejwttoken);
      if (!apiKey) throw new AuthError('unauthenticated');
      this.onFresh(purpose, ++this.generation); return { apiKey, generation: this.generation };
    }
    const source = store[`account-provider:${accountProviderId}:auth-source`];
    if (!source || decode(source) !== 'manual') {
      if (!store['oauth:active_provider'] || decode(store['oauth:active_provider']) !== 'zai' ||
          !store['oauth:zai:user_info'] || !store['oauth:zai:access_token']) {
        for (const provider of ['account:zai-start-plan', 'account:zai-team-coding-plan', 'account:bigmodel-start-plan', 'account:bigmodel-team-coding-plan', 'account:bigmodel-individual-coding-plan'])
          if (store[`account-provider:${provider}:identity`]) throw new UnsupportedPlanError(unsupportedPlan({ providerId: provider })!);
        throw new AuthError('unauthenticated');
      }
      let identity: string;
      try {
        const profile = record(JSON.parse(decode(store['oauth:zai:user_info'])));
        if (typeof profile.id === 'string' && typeof profile.username === 'string' && typeof profile.displayName === 'string') identity = profile.id;
        else {
          identity = typeof profile.user_id === 'string' ? profile.user_id : 'unknown';
          if (!(typeof profile.name === 'string' && profile.name.trim()) && !(typeof profile.email === 'string' && profile.email) && identity === 'unknown') throw new Error();
        }
      } catch (error) { if (error instanceof SharedCredentialError) throw error; throw new AuthError('unauthenticated'); }
      const accessToken = decode(store['oauth:zai:access_token']);
      if (!accessToken) throw new AuthError('unauthenticated');
      this.onFresh(purpose, ++this.generation);
      return { apiKey: '', generation: this.generation, oauth: { identity, accessToken } };
    }
    const rawIdentity = store[`account-provider:${accountProviderId}:identity`];
    if (!rawIdentity) throw new AuthError('unauthenticated');
    const identity = decode(rawIdentity);
    const value = store[`account-provider:coding-plan:${accountProviderId}:account:${encodeURIComponent(identity)}:api-key`];
    if (!identity || !value) throw new AuthError('unauthenticated');
    const apiKey = decode(value);
    if (!apiKey) throw new AuthError('unauthenticated');
    this.onFresh(purpose, ++this.generation);
    return { apiKey, generation: this.generation };
  }
  overlay(revision: string, builtin: string, modelIds?: string[]): Record<string, unknown> {
    this.read('overlay');
    return { revision, basedOnZCodeBuiltinRevision: builtin,
      providers: { [this.account().id]: { access: { type: 'zhipu-account', entitled: true }, ...(modelIds ? { builtinModelIds: modelIds } : {}) } },
      states: { [this.account().id]: { availability: 'available', entitled: true, current: true } } };
  }
  async usageAuthorization(): Promise<string> {
    const fresh = this.read('coding-usage');
    if (!fresh.oauth) return fresh.apiKey;
    this.projectTokens ??= new ProjectTokenResolver(this.network, undefined, undefined, this.clientVersion);
    const original = fresh.oauth;
    const material = await this.projectTokens.resolve(original.identity, original.accessToken, {}, () => {
      const current = this.read('coding-usage-scope').oauth;
      return current?.identity === original.identity && current.accessToken === original.accessToken;
    });
    return material.apiKey;
  }
  private validateHeaders(value: unknown, sessionId: string, workspace: string, selectedModel: string, selectedReasoning: string | undefined, availableModels: readonly string[]): Record<string, unknown> {
    const p = record(value), access = record(p.accountAccess), model = record(p.modelSelection), ws = record(p.workspace);
    const plan = unsupportedPlan(p);
    if (plan && !(this.plan === 'start-plan' && plan === 'Z.ai Start Plan')) throw new UnsupportedPlanError(plan);
    if (p.providerId !== this.account().id || access.type !== 'zhipu-account' || access.mode !== this.account().mode ||
        access.accountType !== 'zai' || access.entitled !== true || model.providerId !== this.account().id ||
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
