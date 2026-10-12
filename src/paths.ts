import { readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const MAX_LINK_DEPTH = 40;

export function registryHome(env: NodeJS.ProcessEnv): string {
  if (env.PORTLEASE_HOME) return resolve(env.PORTLEASE_HOME);
  if (env.XDG_CONFIG_HOME) return join(resolve(env.XDG_CONFIG_HOME), 'portlease');
  return join(homedir(), '.config', 'portlease');
}

// Leases are keyed on this path, so the same directory reached through a symlink must map to one key,
// even after the directory has been deleted (release runs during cleanup).
// A symlink whose target is gone still names that target, so it resolves to it.
export function canonicalPath(path: string, depth = 0): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    const canonicalParent = canonicalPath(parent, depth);
    const leaf = join(canonicalParent, basename(absolute));
    if (depth < MAX_LINK_DEPTH) {
      try {
        return canonicalPath(resolve(canonicalParent, readlinkSync(leaf)), depth + 1);
      } catch {
        // not a symlink
      }
    }
    return leaf;
  }
}
