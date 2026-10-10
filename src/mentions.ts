import { realpathSync } from 'node:fs';
import { isAbsolute, basename } from 'node:path';
import { record } from './errors.ts';

export type SelectedMention = { start: number; end: number; name: string; trigger: '/' | '$'; source: 'skill' | 'command'; origin: 'user' | 'project' };
export type NativeMentionTarget = { name: string; path: string; source: 'skill' | 'command'; origin: 'user' | 'project' };
export function compactSelection(input: readonly unknown[]): { instructions: string } | null {
  if (input.length !== 1) return null;
  const item = record(input[0]);
  if (item.type !== 'text' || typeof item.text !== 'string' || !Array.isArray(item.mentions) || item.mentions.length !== 1) return null;
  const mention = record(item.mentions[0]), resource = record(mention.resource);
  if (resource.kind !== 'command' || resource.source !== 'command' || resource.origin !== 'builtin' || resource.trigger !== '/' || resource.name !== 'compact') return null;
  const start = Number(mention.start), end = Number(mention.end), text = item.text;
  if (!Number.isSafeInteger(mention.start) || !Number.isSafeInteger(mention.end) || start < 0 || end > text.length || end <= start ||
      text.slice(start, end) !== '/compact' || text.slice(0, start).trim() || (text.slice(end) && !/^\s/u.test(text.slice(end)))) return null;
  return { instructions: text.slice(end).trim() };
}
export function selectedMentions(input: readonly unknown[]) {
  const selected: { index: number; mention: SelectedMention }[] = [];
  for (const [index, raw] of input.entries()) {
    const item = record(raw);
    if (item.type !== 'text') continue;
    const text = item.text;
    if (typeof text !== 'string') throw Error('Invalid text input');
    const mentions = item.mentions ?? [];
    if (!Array.isArray(mentions)) throw Error('Invalid selected mentions');
    const ranges: { start: number; end: number }[] = [];
    for (const rawMention of mentions) {
      const m = record(rawMention), resource = record(m.resource);
      if (resource.kind !== 'command') continue;
      if (resource.origin === 'builtin') throw Error('This bb built-in command is not supported by ZCode. Send an ordinary message instead.');
      if (!Number.isSafeInteger(m.start) || !Number.isSafeInteger(m.end) || Number(m.start) < 0 || Number(m.end) <= Number(m.start) || Number(m.end) > text.length ||
          !['/', '$'].includes(String(resource.trigger)) || !['skill', 'command'].includes(String(resource.source)) ||
          !['user', 'project'].includes(String(resource.origin)) || typeof resource.name !== 'string' || !resource.name || /[\s\x00-\x1f\x7f]/u.test(resource.name) ||
          text.slice(Number(m.start), Number(m.end)) !== `${resource.trigger}${resource.name}`)
        throw Error('Selected skill or command no longer matches the text. Select it again.');
      if (resource.source === 'command' && resource.trigger !== '/') throw Error('Select a native command using /');
      const start = Number(m.start), end = Number(m.end);
      if (ranges.some(r => start < r.end && end > r.start)) throw Error('Overlapping selected mentions. Select each item once.');
      ranges.push({ start, end });
      selected.push({ index, mention: { start, end, name: resource.name, trigger: resource.trigger as '/' | '$', source: resource.source as 'skill' | 'command', origin: resource.origin as 'user' | 'project' } });
    }
  }
  if (selected.filter(s => s.mention.source === 'command').length > 1) throw Error('Send selected native commands separately, one command per message.');
  return selected;
}
// CLI metadata is selected with the actual thread's isolated HOME/config and
// plugin preload. A skill must ALSO exist in that resident session's catalogue.
export function resolveMentionTarget(m: SelectedMention, catalogue: unknown, sessionSkills?: unknown): NativeMentionTarget {
  const side = m.source === 'skill' ? 'skills' : 'commands', rows = record(catalogue)[side];
  if (!Array.isArray(rows)) throw Error('Native mention catalogue unavailable. Send an ordinary message or select again after resume.');
  const candidates = rows.map(record).filter(r => r.scope === m.origin && (r.name === m.name || r.qualifiedName === m.name) && typeof r.path === 'string');
  if (candidates.length !== 1) throw Error('Selected native item is unavailable or ambiguous. Select it again.');
  const row = candidates[0]!;
  if (row.qualifiedName !== undefined && typeof row.qualifiedName !== 'string') throw Error('Native mention identity is unknown');
  let path: string;
  try { path = realpathSync(String(row.path)); } catch { throw Error('Selected native item is unavailable. Select it again.'); }
  const name = typeof row.qualifiedName === 'string' ? row.qualifiedName : String(row.name);
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/u.test(path) || !name || /[\s\x00-\x1f\x7f]/u.test(name)) throw Error('Native mention identity is invalid');
  if (m.source === 'command' && (name.split(':').length > 2 || name.split(':').at(-1) !== basename(path).replace(/\.md$/i, '').toLowerCase()))
    throw Error('This native command name cannot be represented by bb');
  if (m.source === 'command' && row.disableNonInteractive === true) throw Error('This native command is unavailable in the ZCode app-server');
  if (m.source === 'skill') {
    const current = record(sessionSkills);
    if (current.authority !== 'session' || !Array.isArray(current.skills)) throw Error('Native session skill catalogue is unknown');
    const matches = current.skills.map(record).filter(r => {
      if (r.enabled !== true || typeof r.path !== 'string' || !(r.name === row.name || r.name === name) ||
          !(r.scope === (m.origin === 'project' ? 'workspace' : 'user') || r.scope === 'plugin')) return false;
      try { return realpathSync(r.path) === path; } catch { return false; }
    });
    if (matches.length !== 1) throw Error('Selected skill is not available in this native session. Start a new thread after refreshing the menu.');
  }
  return { name, path, source: m.source, origin: m.origin };
}
function label(s: string) { return s.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]'); }
function destination(s: string) { return s.replaceAll('\\', '\\\\').replaceAll('>', '\\>'); }
export async function convertMentions(input: readonly unknown[], lookup: (m: SelectedMention) => Promise<NativeMentionTarget>) {
  const selected = selectedMentions(input);
  if (!selected.length) return { input: [...input], targets: [] as NativeMentionTarget[] };
  const targets: NativeMentionTarget[] = [], replacements = new Map<number, { mention: SelectedMention; text: string }[]>();
  let command: NativeMentionTarget | undefined;
  for (const s of selected) {
    const target = await lookup(s.mention); targets.push(target);
    if (target.source !== s.mention.source || target.origin !== s.mention.origin) throw Error('Native mention source changed');
    if (target.source === 'command') command = target;
    const text = target.source === 'skill' ? `[${label('$' + target.name)}](<${destination(target.path)}>)` : '';
    const list = replacements.get(s.index) ?? []; list.push({ mention: s.mention, text }); replacements.set(s.index, list);
  }
  const converted = input.map((raw, index) => {
    const item = record(raw); let text = item.text;
    for (const replacement of (replacements.get(index) ?? []).sort((a, b) => b.mention.start - a.mention.start))
      text = String(text).slice(0, replacement.mention.start) + replacement.text + String(text).slice(replacement.mention.end);
    return item.type === 'text' ? { ...item, text, mentions: [] } : raw;
  });
  // Preserve chunk order and every remaining user character; one native
  // command consumes the whole text as arguments through ZCode's own resolver.
  if (command) {
    const first = converted.findIndex(raw => record(raw).type === 'text');
    const item = record(converted[first]); converted[first] = { ...item, text: '/' + command.name + '\n' + String(item.text) };
  }
  const skills = targets.filter(t => t.source === 'skill');
  if (skills.length) converted.push({ type: 'text', text: 'Load the selected native skills with the Skill tool before carrying out this request: ' + [...new Set(skills.map(s => s.name))].map(n => JSON.stringify(n)).join(', ') + '.', mentions: [], visibility: 'agent-only' });
  return { input: converted, targets };
}
