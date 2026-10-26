import { record } from './errors.ts';
import { isAbsolute } from 'node:path';
import { authMode } from './auth.ts';

// ADR-022: SDK validates full/user-null policy; this layer decides execution.
export function executionOptions(value: unknown, instructionMode = 'append', disallowed: unknown = []) {
  const o = record(value);
  if (o.permissionMode !== 'full' || o.permissionScope !== 'full' || o.approvalReviewer !== null || o.permissionEscalation !== null)
    throw new Error('Only full permissions with null approval reviewer/escalation are supported');
  if (o.promptMode !== undefined) throw new Error('ZCode plan mode is not supported');
  if (o.serviceTier !== undefined && o.serviceTier !== 'default') throw new Error('ZCode fast service tier is not supported');
  const providerOptions = record(o.providerOptions ?? {});
  if (Object.keys(providerOptions).some(key => !['additionalWorkspaceWriteRoots', 'authMode', 'catalogueRefresh', 'providerSubagentsEnabled', 'memoryEnabled'].includes(key))) throw new Error('ZCode providerOptions are not supported');
  if (providerOptions.providerSubagentsEnabled !== undefined && typeof providerOptions.providerSubagentsEnabled !== 'boolean') throw Error('Invalid subagent setting');
  const providerSubagentsEnabled = providerOptions.providerSubagentsEnabled !== false;
  if (providerOptions.memoryEnabled !== undefined && typeof providerOptions.memoryEnabled !== 'boolean') throw Error('Invalid memory setting');
  const memoryEnabled = providerOptions.memoryEnabled !== false;
  const selectedAuthMode = authMode(providerOptions.authMode);
  if (providerOptions.catalogueRefresh !== undefined && (!Number.isSafeInteger(providerOptions.catalogueRefresh) || Number(providerOptions.catalogueRefresh) < 0)) throw new Error('Invalid catalogue refresh');
  // bb supplies these roots even for full. Native yolo already permits them;
  // accepting valid roots neither creates mounts nor grants a new permission.
  const roots = providerOptions.additionalWorkspaceWriteRoots;
  if (roots !== undefined && (!Array.isArray(roots) || roots.some(p => typeof p !== 'string' || !isAbsolute(p) || p.includes('\0'))))
    throw new Error('Invalid additionalWorkspaceWriteRoots');
  if (!Array.isArray(disallowed) || disallowed.some(name => typeof name !== 'string' || !name.trim())) throw new Error('Invalid disallowedTools');
  // Native owns matching semantics; patterns and unknown names pass through.
  const toolDenylist = [...new Set([...disallowed as string[], ...(!providerSubagentsEnabled ? ['Agent'] : [])])];
  const instructions = typeof o.instructions === 'string' ? o.instructions : '';
  if (instructions && instructionMode !== 'append') throw new Error('ZCode instruction replacement is not supported; select append');
  const envVars: NodeJS.ProcessEnv = {};
  for (const [key, val] of Object.entries(record(o.envVars ?? {}))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof val !== 'string' || val.includes('\0')) throw new Error('Unsupported explicit ZCode environment variable');
    envVars[key] = val;
  }
  if (o.model !== undefined && (typeof o.model !== 'string' || !o.model.trim())) throw new Error('Invalid explicit model');
  const model = typeof o.model === 'string' ? o.model : '';
  if (o.reasoningLevel !== undefined && (typeof o.reasoningLevel !== 'string' || !o.reasoningLevel.trim())) throw new Error('Invalid explicit reasoning');
  const reasoning = typeof o.reasoningLevel === 'string' ? o.reasoningLevel : ''; // native default sentinel
  return { model, reasoning, instructions, envVars, authMode: selectedAuthMode, catalogueRefresh: Number(providerOptions.catalogueRefresh ?? 0), providerSubagentsEnabled, memoryEnabled,
    toolDenylist, signature: JSON.stringify([instructions, Object.entries(envVars).sort(), toolDenylist, memoryEnabled]) };
}
