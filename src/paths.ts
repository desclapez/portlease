import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export function registryHome(env: NodeJS.ProcessEnv): string {
  if (env.PORTLEASE_HOME) return resolve(env.PORTLEASE_HOME);
  if (env.XDG_CONFIG_HOME) return join(resolve(env.XDG_CONFIG_HOME), 'portlease');
  return join(homedir(), '.config', 'portlease');
}

// Leases are keyed on this path, so the same directory reached through a symlink must map to one key,
// even after the directory has been deleted (release runs during cleanup).
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(canonicalPath(parent), basename(absolute));
  }
}
