import { readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { record } from './errors.ts';

export type BbSkill = { name: string; description: string; path: string };
export type SkillRoot = { id: string; path: string; skills: { name: string; description: string; [key: string]: unknown }[] };
// SDK roots are staged directories (including namespaced plugin names), not
// name-to-path substitutions. Resolve actual files and canonical aliases.
export function skillFiles(root: string): string[] {
  try {
    if (statSync(root).isFile()) return basename(root) === 'SKILL.md' ? [realpathSync(root)] : [];
    const candidates = [join(root, 'SKILL.md'), ...readdirSync(root).map(n => join(root, n, 'SKILL.md'))];
    return candidates.flatMap(p => { try { return statSync(p).isFile() ? [realpathSync(p)] : []; } catch { return []; } });
  } catch { return []; }
}
export function skillName(path: string): string {
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? '';
  const value = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
  return value?.replace(/^(['"])(.*)\1$/, '$2') ?? basename(join(path, '..'));
}
export function bbOnlySkills(roots: readonly SkillRoot[], nativeCatalogue: unknown): { skills: BbSkill[]; excluded: { name: string; path: string; reason: string }[] } {
  const rows = record(nativeCatalogue).skills;
  if (!Array.isArray(rows)) throw Error('Native skill discovery unavailable');
  const nativePaths = new Set<string>(), nativeNames = new Set<string>();
  // Unlike referenceCatalog, CLI discovery includes bundled records. Preserve
  // all native aliases: an injected entry cannot override native bare lookup.
  for (const raw of rows) {
    const row = record(raw);
    if (typeof row.path !== 'string' || typeof row.name !== 'string') continue;
    try { nativePaths.add(realpathSync(row.path)); } catch { continue; }
    nativeNames.add(row.name);
    if (typeof row.qualifiedName === 'string') nativeNames.add(row.qualifiedName);
  }
  const paths = new Set<string>(), names = new Set<string>(), skills: BbSkill[] = [], excluded: { name: string; path: string; reason: string }[] = [];
  for (const root of roots) {
    const files = skillFiles(root.path).map(path => ({ path, name: skillName(path) }));
    for (const meta of root.skills) {
      // filePath/path are SDK passthrough metadata where supplied. Otherwise
      // match frontmatter to the effective (possibly qualified) SDK name.
      const explicit = meta.filePath ?? meta.path;
      const matches = files.filter(f => typeof explicit === 'string' ? (() => { try { return realpathSync(explicit) === f.path; } catch { return false; } })() : f.name === meta.name || f.name === meta.name.split(':').at(-1));
      if (!matches.length) { excluded.push({ name: meta.name, path: root.path, reason: 'unavailable-file' }); continue; }
      const path = matches[0]!.path;
      const reason = nativePaths.has(path) ? 'native-canonical-path' : nativeNames.has(meta.name) ? 'native-name-winner' : paths.has(path) ? 'bb-canonical-path' : names.has(meta.name) ? 'bb-root-order-winner' : '';
      if (reason) { excluded.push({ name: meta.name, path, reason }); continue; }
      paths.add(path); names.add(meta.name); skills.push({ name: meta.name, description: meta.description, path });
    }
  }
  return { skills, excluded };
}
export function skillsBlock(skills: readonly BbSkill[]) {
  return skills.length ? '[bb skills]\nRead the relevant SKILL.md using the file tool before applying it. These bb skills are not registered in the native Skill tool.\n' + skills.map(s => `- ${s.name}: ${s.description.replace(/\s+/g, ' ')} (file: ${s.path})`).join('\n') : '';
}
