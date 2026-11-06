import type { AccountPlan } from './auth.ts';

// Only bb IDs carry a plan namespace. Native IDs and provider IDs stay intact.
export const startModelPrefix = 'start-plan/';
export function selectedModel(model: string): { model: string; accountPlan: AccountPlan } {
  if (!model.startsWith(startModelPrefix)) return { model, accountPlan: 'coding-plan' };
  const native = model.slice(startModelPrefix.length);
  if (!native || native.includes('/')) throw Error('Invalid Start Plan model selection');
  return { model: native, accountPlan: 'start-plan' };
}
export function startModelId(native: string): string { return startModelPrefix + native; }
