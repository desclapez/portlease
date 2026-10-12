import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Range } from './allocate.ts';
import { ExitCode, PortleaseError } from './errors.ts';

export const REGISTRY_VERSION = 1;
export const DEFAULT_RANGE: Range = { min: 20000, max: 29999 };

export type Lease = { dir: string; name: string; port: number; claimedAt: string };
export type Registry = { version: number; cursor: number; leases: Lease[] };
export type Config = { range: Range };

const LEASES_FILE = 'leases.json';
const CONFIG_FILE = 'config.json';

const registryError = (message: string) => new PortleaseError(message, ExitCode.registry);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

const isPort = (value: unknown): value is number => isInteger(value) && value >= 1 && value <= 65535;

const isLease = (value: unknown): value is Lease =>
  isObject(value) &&
  typeof value.dir === 'string' &&
  typeof value.name === 'string' &&
  isPort(value.port) &&
  typeof value.claimedAt === 'string';

function readJson(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw registryError(`cannot read ${file}: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw registryError(`${file} is not valid JSON. Fix it, or delete it to forget every lease`);
  }
}

export function readConfig(home: string): Config {
  const file = join(home, CONFIG_FILE);
  const data = readJson(file);
  if (data === undefined) return { range: DEFAULT_RANGE };
  if (!isObject(data)) throw registryError(`${file} must be a JSON object`);
  if (data.range === undefined) return { range: DEFAULT_RANGE };

  const invalid = () => registryError(`${file}: "range" must be { "min": <port>, "max": <port> } with min <= max`);
  if (!isObject(data.range)) throw invalid();
  const { min, max } = data.range;
  if (!isPort(min) || !isPort(max) || min > max) throw invalid();
  return { range: { min, max } };
}

export function emptyRegistry(range: Range): Registry {
  return { version: REGISTRY_VERSION, cursor: range.min, leases: [] };
}

function assertConsistent(leases: Lease[], file: string): void {
  const ports = new Set<number>();
  const keys = new Set<string>();
  for (const lease of leases) {
    const key = `${lease.dir}\0${lease.name}`;
    if (ports.has(lease.port) || keys.has(key)) {
      throw registryError(
        `${file} is inconsistent: port ${lease.port} or ${lease.name} in ${lease.dir} appears twice. Fix it, or delete it to forget every lease`,
      );
    }
    ports.add(lease.port);
    keys.add(key);
  }
}

export function readRegistry(home: string, range: Range): Registry {
  const file = join(home, LEASES_FILE);
  const data = readJson(file);
  if (data === undefined) return emptyRegistry(range);
  if (!isObject(data) || !isInteger(data.version) || data.version < 1) {
    throw registryError(`${file} is malformed: missing or invalid "version". Fix it, or delete it to forget every lease`);
  }
  if (data.version > REGISTRY_VERSION) {
    throw registryError(
      `${file} uses format version ${data.version}, newer than this portlease understands (${REGISTRY_VERSION}). Upgrade portlease`,
    );
  }
  const { cursor, leases } = data;
  if (!isInteger(cursor) || !Array.isArray(leases) || !leases.every(isLease)) {
    throw registryError(`${file} is malformed. Fix it, or delete it to forget every lease`);
  }
  assertConsistent(leases, file);
  return { version: REGISTRY_VERSION, cursor, leases };
}

export function saveRegistry(home: string, registry: Registry): void {
  const file = join(home, LEASES_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`);
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // the temp file was never created
    }
    throw registryError(`cannot save ${file}: ${(error as Error).message}`);
  }
}

export function pruneMissingDirs(registry: Registry, dirExists: (dir: string) => boolean): Registry {
  return { ...registry, leases: registry.leases.filter((lease) => dirExists(lease.dir)) };
}
