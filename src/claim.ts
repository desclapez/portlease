import { allocatePort, type Range } from './allocate.ts';
import type { Lease, Registry } from './registry.ts';

export type LeaseResult = { name: string; port: number; reused: boolean };

export async function leaseNames(options: {
  registry: Registry;
  dir: string;
  names: readonly string[];
  range: Range;
  isFree: (port: number) => Promise<boolean>;
  now: Date;
}): Promise<{ registry: Registry; results: LeaseResult[] }> {
  const { dir, range, isFree } = options;
  const leases: Lease[] = [...options.registry.leases];
  const taken = new Set(leases.map((lease) => lease.port));
  let cursor = options.registry.cursor;
  const results: LeaseResult[] = [];

  for (const name of options.names) {
    const existing = leases.find((lease) => lease.dir === dir && lease.name === name);
    if (existing) {
      results.push({ name, port: existing.port, reused: true });
      continue;
    }
    const allocation = await allocatePort({ range, cursor, taken, isFree });
    cursor = allocation.cursor;
    taken.add(allocation.port);
    leases.push({ dir, name, port: allocation.port, claimedAt: options.now.toISOString() });
    results.push({ name, port: allocation.port, reused: false });
  }

  return { registry: { ...options.registry, cursor, leases }, results };
}
