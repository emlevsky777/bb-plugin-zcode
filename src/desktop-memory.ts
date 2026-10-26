import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Desktop 3.14.4 resolves runtime preferences from its v2 settings service.
// Only the owner's memory boolean is shared; this reader never writes settings.
export function desktopMemoryEnabled(home = homedir()): boolean | undefined {
  try {
    const value = JSON.parse(readFileSync(join(home, '.zcode/v2/setting.json'), 'utf8'))?.memoryEnabled;
    return typeof value === 'boolean' ? value : undefined;
  } catch { return undefined; }
}
