import { constants, openSync, fstatSync, readFileSync, closeSync, existsSync, mkdirSync, writeFileSync, realpathSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { record } from './errors.ts';

export const personalSettingsWarning = 'Personal ZCode settings are unavailable or invalid. Personal settings are disabled; you can continue this conversation.';
export function readPersonalSettings(cwd: string, userHome = homedir()) {
  const configPath = join(userHome, '.zcode/cli/config.json');
  let fd: number | undefined;
  try {
    fd = openSync(configPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 1024 * 1024) throw Error('Invalid optional config');
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('Invalid optional config');
    const input = record(parsed);
    if (input.skills !== undefined && (!input.skills || typeof input.skills !== 'object' || Array.isArray(input.skills))) throw Error('Invalid skills config');
    const skills = record(input.skills ?? {}), supported: Record<string, unknown> = {};
    if (Object.keys(skills).some(k => !['enabled', 'includeInstructions', 'metadataBudget', 'roots'].includes(k))) throw Error('Unsupported skill config');
    for (const k of ['enabled', 'includeInstructions']) if (skills[k] !== undefined) {
      if (typeof skills[k] !== 'boolean') throw Error('Invalid skills boolean'); supported[k] = skills[k];
    }
    if (skills.metadataBudget !== undefined) {
      if (typeof skills.metadataBudget !== 'number' || !Number.isFinite(skills.metadataBudget) || skills.metadataBudget <= 0) throw Error('Invalid budget');
      supported.metadataBudget = skills.metadataBudget;
    }
    if (skills.roots !== undefined) {
      if (!Array.isArray(skills.roots) || skills.roots.some(p => typeof p !== 'string' || !p || p.includes('\0'))) throw Error('Invalid roots');
      supported.roots = [...new Set(skills.roots.map(p => resolve(p.startsWith('~/') ? join(userHome, p.slice(2)) : resolve(cwd, p))))];
    }
    const config: Record<string, unknown> = { skills: supported };
    for (const kind of ['skill', 'command']) if (input[kind] !== undefined) {
      if (!input[kind] || typeof input[kind] !== 'object' || Array.isArray(input[kind])) throw Error('Invalid overrides');
      const entries = record(input[kind]);
      for (const [path, raw] of Object.entries(entries)) {
        const v = record(raw); if (!path.startsWith('/') || typeof v.enable !== 'boolean' || Object.keys(v).some(k => k !== 'enable')) throw Error('Invalid path override');
      }
      config[kind] = entries;
    }
    return { config, warnings: [] as string[] };
  } catch (e) { return { config: {}, warnings: record(e).code === 'ENOENT' ? [] : [personalSettingsWarning] }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

// Only links created by this function may be reconciled. Never link config,
// history, DB, memory or an entire HOME; source files stay in their original roots.
export function preparePersonalSettings(ownHome: string, dataRoot: string, cwd: string, userHome = homedir()) {
  mkdirSync(ownHome, { recursive: true, mode: 0o700 });
  ownHome = realpathSync(ownHome);
  if (ownHome === realpathSync(userHome)) throw Error('Isolated HOME required');
  const ownDir = (path: string) => {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (lstatSync(path).isSymbolicLink() || !realpathSync(path).startsWith(ownHome + '/')) throw Error('Own config directory conflict');
  };
  const layer = readPersonalSettings(cwd, userHome);
  for (const rel of ['.zcode/skills', '.agents/skills', '.zcode/commands', '.agents/commands']) {
    const target = join(ownHome, rel), source = join(userHome, rel);
    ownDir(dirname(target));
    let ownedLink = false;
    try {
      const st = lstatSync(target);
      if (!st.isSymbolicLink() || readlinkSync(target) !== source) throw Error('Own native root conflict');
      ownedLink = true;
    } catch (e) { if (record(e).code !== 'ENOENT') throw e; }
    let available = false;
    try { available = lstatSync(realpathSync(source)).isDirectory(); if (!available) layer.warnings.push('A personal ZCode skill or command directory is unavailable. Only that directory is disabled.'); }
    catch (e) { if (record(e).code !== 'ENOENT') layer.warnings.push('A personal ZCode skill or command directory is unavailable. Only that directory is disabled.'); }
    if (ownedLink && !available) unlinkSync(target);
    if (!ownedLink && available) symlinkSync(source, target, 'dir');
  }
  const file = join(ownHome, '.zcode/cli/config.json');
  ownDir(join(ownHome, '.zcode')); ownDir(dirname(file));
  // The user layer is a supported projection, never a shallow merge of storage,
  // providers, network, permission or memory settings from the personal file.
  const config = { ...layer.config, storage: { dir: dataRoot }, memory: { use: false }, hooks: { enabled: false },
    permission: { mode: 'yolo' } };
  const temp = file + '.' + randomUUID() + '.tmp';
  try { writeFileSync(temp, JSON.stringify(config) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }); renameSync(temp, file); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
  return { config, configPath: file, warnings: [...new Set(layer.warnings)] };
}
