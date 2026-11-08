import { sep } from 'node:path';
import type { Range } from './allocate.ts';
import type { Listener } from './listeners.ts';
import type { Lease } from './registry.ts';

// `unleased` only answers `scan <port>` about a port nothing else reports; `in-use` is set by the CLI for a
// port that a bind probe finds busy while lsof shows no listener (or without lsof at all), never by `classify`.
export type ScanStatus = 'free' | 'ok' | 'held-by-other' | 'not-leased' | 'unleased-in-range' | 'unleased' | 'in-use';

export type ScanEntry = {
  port: number;
  lease: { dir: string; name: string } | null;
  listener: { pid: number; command: string; cwd: string | null } | null;
  // The leased directory the listener belongs to; set for `ok` and `not-leased`.
  ownerDir: string | null;
  status: ScanStatus;
};

const isWithin = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);

// A process belongs to the deepest leased directory it runs in.
export function owner(cwd: string | null, dirs: readonly string[]): string | null {
  if (cwd === null) return null;
  let best: string | null = null;
  for (const dir of dirs) {
    if (isWithin(cwd, dir) && (best === null || dir.length > best.length)) best = dir;
  }
  return best;
}

const toListener = ({ pid, command, cwd }: Listener) => ({ pid, command, cwd });

const byPortThenPid = (a: Listener, b: Listener) => a.port - b.port || a.pid - b.pid;

export function classify(options: { leases: Lease[]; listeners: Listener[]; range: Range; port?: number }): ScanEntry[] {
  const { range } = options;
  const leases = [...options.leases].sort((a, b) => a.dir.localeCompare(b.dir) || a.port - b.port);
  const listeners = [...options.listeners].sort(byPortThenPid);
  const dirs = [...new Set(leases.map((lease) => lease.dir))];
  const leasedPorts = new Set(leases.map((lease) => lease.port));
  const ownerOf = new Map(listeners.map((listener) => [listener, owner(listener.cwd, dirs)]));
  const entries: ScanEntry[] = [];

  for (const { dir, name, port } of leases) {
    const holders = listeners.filter((listener) => listener.port === port);
    if (holders.length === 0) {
      entries.push({ port, lease: { dir, name }, listener: null, ownerDir: null, status: 'free' });
      continue;
    }
    for (const holder of holders) {
      const ok = ownerOf.get(holder) === dir;
      entries.push({
        port,
        lease: { dir, name },
        listener: toListener(holder),
        ownerDir: ok ? dir : null,
        status: ok ? 'ok' : 'held-by-other',
      });
    }
  }

  const notLeased = listeners
    .map((listener) => ({ listener, dir: ownerOf.get(listener) ?? null }))
    .filter(
      (item): item is { listener: Listener; dir: string } =>
        item.dir !== null && !leases.some((lease) => lease.dir === item.dir && lease.port === item.listener.port),
    )
    .sort((a, b) => a.dir.localeCompare(b.dir) || byPortThenPid(a.listener, b.listener));
  for (const { listener, dir } of notLeased) {
    entries.push({ port: listener.port, lease: null, listener: toListener(listener), ownerDir: dir, status: 'not-leased' });
  }

  for (const listener of listeners) {
    const inRange = listener.port >= range.min && listener.port <= range.max;
    if (inRange && !leasedPorts.has(listener.port) && ownerOf.get(listener) === null) {
      entries.push({ port: listener.port, lease: null, listener: toListener(listener), ownerDir: null, status: 'unleased-in-range' });
    }
  }

  if (options.port === undefined) return entries;
  const port = options.port;
  const matching = entries.filter((entry) => entry.port === port);
  if (matching.length > 0) return matching;
  return listeners
    .filter((listener) => listener.port === port)
    .map((listener) => ({ port, lease: null, listener: toListener(listener), ownerDir: null, status: 'unleased' as const }));
}
