import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { leaseNames, type LeaseResult } from './claim.ts';
import { diffEnv, readEnvFile, writeEnvFile, type EnvChange } from './env-file.ts';
import { ExitCode, PortleaseError } from './errors.ts';
import { isPortFree } from './free-port.ts';
import type { Listener } from './listeners.ts';
import { withLock } from './lock.ts';
import { canonicalPath, registryHome } from './paths.ts';
import { distinctNames, findManifest, type Section } from './manifest.ts';
import { pruneMissingDirs, type Lease, readConfig, readRegistry, saveRegistry } from './registry.ts';
import { classify, type ScanEntry } from './scan.ts';

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  // null when lsof cannot be run.
  listListeners: () => Promise<Listener[] | null>;
};

const USAGE = `Usage:
  portlease claim [--dir <dir>] [--dry-run]
  portlease release [--dir <dir>]
  portlease ls [--json]
  portlease scan [port] [--json]
`;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function parseOrUsage<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new PortleaseError((error as Error).message, ExitCode.usage);
  }
}

// In the section's own order, so names missing from the env file are appended as the manifest lists them.
function sectionValues(section: Section, results: LeaseResult[]): Map<string, number> {
  const ports = new Map(results.map(({ name, port }) => [name, port]));
  return new Map(section.names.map((name) => [name, ports.get(name) as number]));
}

type EnvDiff = { label: string; changes: EnvChange[] };

function formatDryRun(dir: string, results: LeaseResult[], released: Lease[], diffs: EnvDiff[]): string {
  const lines = [`Dry run for ${dir}: nothing was written.`, ''];
  for (const { name, port, reused } of results) {
    lines.push(`  ${name}=${port}  ${reused ? 'existing lease' : 'new lease (tentative)'}`);
  }
  for (const { name, port } of released) {
    lines.push(`  Would release ${name}=${port}  (no longer in .portlease)`);
  }
  for (const { label, changes } of diffs) {
    lines.push('');
    if (changes.length === 0) {
      lines.push(`${label}: no changes`);
      continue;
    }
    lines.push(`${label}:`);
    for (const change of changes) {
      lines.push(change.kind === 'append' ? `  + ${change.after}` : `  ~ ${change.before}  ->  ${change.after}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function claim(args: string[], io: Io): Promise<number> {
  const { values } = parseOrUsage(() =>
    parseArgs({
      args,
      strict: true,
      options: {
        dir: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
    }),
  );

  const start = canonicalPath(resolve(io.cwd, values.dir ?? '.'));
  if (!isDirectory(start)) throw new PortleaseError(`${start} is not an existing directory`, ExitCode.usage);
  const manifest = findManifest(start);
  const { dir, sections } = manifest;
  const envFiles = sections.map((section) => ({ section, file: resolve(dir, section.envFile) }));

  // Writing ports into a file the project has not created yet would leave a file with only ports,
  // which a later "copy .env.example if missing" step would then skip.
  const missing = envFiles.filter(({ file }) => !existsSync(file));
  if (missing.length > 0) {
    throw new PortleaseError(
      missing
        .map(({ section }) => `${section.envFile} does not exist: create it before leasing ports (for example from its .env.example)`)
        .join('\n'),
      ExitCode.usage,
    );
  }

  const names = distinctNames(sections);
  const home = registryHome(io.env);
  const { range } = readConfig(home);

  const plan = () =>
    leaseNames({
      registry: pruneMissingDirs(readRegistry(home, range), isDirectory),
      dir,
      names,
      range,
      isFree: isPortFree,
      now: new Date(),
    });

  if (values['dry-run']) {
    const { results, released } = await plan();
    const diffs = envFiles.map(({ section, file }) => ({
      label: section.envFile,
      changes: diffEnv(readEnvFile(file), sectionValues(section, results)),
    }));
    io.stdout(formatDryRun(dir, results, released, diffs));
    return ExitCode.ok;
  }

  const { results, released } = await withLock(home, async () => {
    const outcome = await plan();
    saveRegistry(home, outcome.registry);
    return outcome;
  });

  // One unwritable file must not keep the others from getting their ports; claim again repairs it.
  const failures: PortleaseError[] = [];
  for (const { section, file } of envFiles) {
    try {
      writeEnvFile(file, sectionValues(section, results));
    } catch (error) {
      if (!(error instanceof PortleaseError)) throw error;
      failures.push(error);
    }
  }

  io.stderr(`Leased for ${dir}:\n`);
  for (const { name, port } of released) io.stderr(`Released ${name}=${port}\n`);
  if (failures.length > 0) {
    for (const failure of failures) io.stderr(`portlease: ${failure.message}\n`);
    return ExitCode.envWrite;
  }
  io.stdout(results.map(({ name, port }) => `${name}=${port}\n`).join(''));
  return ExitCode.ok;
}

async function release(args: string[], io: Io): Promise<number> {
  const { values } = parseOrUsage(() => parseArgs({ args, strict: true, options: { dir: { type: 'string' } } }));
  const dir = canonicalPath(resolve(io.cwd, values.dir ?? '.'));
  const home = registryHome(io.env);
  const { range } = readConfig(home);

  const released = await withLock(home, async () => {
    const registry = readRegistry(home, range);
    const kept = registry.leases.filter((lease) => lease.dir !== dir);
    const count = registry.leases.length - kept.length;
    if (count > 0) saveRegistry(home, { ...registry, leases: kept });
    return count;
  });
  io.stderr(`Released ${released} port(s) for ${dir}\n`);
  return ExitCode.ok;
}

function ls(args: string[], io: Io): number {
  const { values } = parseOrUsage(() => parseArgs({ args, strict: true, options: { json: { type: 'boolean' } } }));
  const home = registryHome(io.env);
  const { range } = readConfig(home);
  const leases = [...readRegistry(home, range).leases].sort((a, b) => a.dir.localeCompare(b.dir) || a.port - b.port);

  if (values.json) {
    const rows = leases.map((lease) => ({ ...lease, dirExists: isDirectory(lease.dir) }));
    io.stdout(`${JSON.stringify(rows, null, 2)}\n`);
    return ExitCode.ok;
  }
  if (leases.length === 0) {
    io.stdout('No leases.\n');
    return ExitCode.ok;
  }

  const lines: string[] = [];
  let current: string | undefined;
  for (const lease of leases) {
    if (lease.dir !== current) {
      current = lease.dir;
      lines.push(isDirectory(lease.dir) ? lease.dir : `${lease.dir} (missing)`);
    }
    lines.push(`  ${lease.name}=${lease.port}`);
  }
  io.stdout(`${lines.join('\n')}\n`);
  return ExitCode.ok;
}

function parsePort(arg: string): number {
  const port = /^\d+$/.test(arg) ? Number(arg) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PortleaseError(`"${arg}" is not a port`, ExitCode.usage);
  }
  return port;
}

const describeListener = ({ command, pid }: { command: string; pid: number }) => `${command} ${pid}`;
const whereFrom = (cwd: string | null) => `(${cwd ?? 'unknown directory'})`;

// Without lsof, all scan can tell is whether each leased port is taken.
async function probeLeases(leases: Lease[], port: number | undefined): Promise<ScanEntry[]> {
  const selected = leases
    .filter((lease) => port === undefined || lease.port === port)
    .sort((a, b) => a.dir.localeCompare(b.dir) || a.port - b.port);
  const entries: ScanEntry[] = [];
  for (const { dir, name, port: leased } of selected) {
    const status = (await isPortFree(leased)) ? 'free' : 'in-use';
    entries.push({ port: leased, lease: { dir, name }, listener: null, ownerDir: null, status });
  }
  if (port !== undefined && entries.length === 0 && !(await isPortFree(port))) {
    entries.push({ port, lease: null, listener: null, ownerDir: null, status: 'in-use' });
  }
  return entries;
}

// lsof lists no socket of a process it cannot inspect (another user, root, Docker's proxy on Linux),
// so a port it shows no listener for is only free if a bind probe agrees.
async function confirmFree(entries: ScanEntry[], port: number | undefined): Promise<ScanEntry[]> {
  const confirmed: ScanEntry[] = [];
  for (const entry of entries) {
    const busy = entry.status === 'free' && !(await isPortFree(entry.port));
    confirmed.push(busy ? { ...entry, status: 'in-use' } : entry);
  }
  if (port !== undefined && confirmed.length === 0 && !(await isPortFree(port))) {
    confirmed.push({ port, lease: null, listener: null, ownerDir: null, status: 'in-use' });
  }
  return confirmed;
}

const invisibleHolder = (port: number) =>
  `holder not visible to lsof: another user or root. Try: sudo lsof -nP -iTCP:${port} -sTCP:LISTEN`;

function formatScan(entries: ScanEntry[], port: number | undefined, lsofAvailable: boolean): string {
  if (entries.length === 0) return port === undefined ? 'No leases.\n' : `${port}: free, not leased\n`;
  const unrelated = entries.filter((entry) => entry.status === 'unleased' || (entry.status === 'in-use' && !entry.lease));
  if (unrelated.length > 0) {
    return unrelated
      .map(({ listener }) => {
        if (listener) return `${port}: ${describeListener(listener)} ${whereFrom(listener.cwd)}, not leased\n`;
        return lsofAvailable ? `${port}: in use, not leased (${invisibleHolder(port as number)})\n` : `${port}: in use, not leased\n`;
      })
      .join('');
  }

  const label = (entry: ScanEntry) => (entry.lease ? `${entry.lease.name}=${entry.port}` : `⚠ ${entry.port}`);
  const width = Math.max(...entries.map((entry) => label(entry).length));
  const line = (entry: ScanEntry, text: string) => `  ${label(entry).padEnd(width)}  ${text}`;

  const lines: string[] = [];
  const dirs = [...new Set(entries.map((entry) => entry.lease?.dir ?? entry.ownerDir).filter((dir) => dir !== null))].sort((a, b) =>
    a.localeCompare(b),
  );
  if (dirs.length === 0 && port === undefined) lines.push('No leases.');
  for (const dir of dirs) {
    lines.push(isDirectory(dir) ? dir : `${dir} (missing)`);
    for (const entry of entries.filter((item) => item.lease?.dir === dir)) {
      const { listener } = entry;
      if (entry.status === 'ok' && listener) lines.push(line(entry, `listening ${describeListener(listener)} (this directory)`));
      else if (entry.status === 'held-by-other' && listener) {
        lines.push(line(entry, `⚠ held by ${describeListener(listener)} ${whereFrom(listener.cwd)}`));
      } else if (entry.status === 'in-use') {
        lines.push(line(entry, lsofAvailable ? `⚠ in use, ${invisibleHolder(entry.port)}` : 'in use'));
      } else lines.push(line(entry, 'free'));
    }
    const notLeased = entries.filter((item) => item.status === 'not-leased' && item.ownerDir === dir);
    for (const entry of notLeased) {
      if (entry.listener) lines.push(line(entry, `listening ${describeListener(entry.listener)} (this directory), not leased`));
    }
    if (notLeased.length > 0) {
      lines.push(`      → run: portlease claim --dir ${dir}, then restart its servers`);
    }
  }

  const unleased = entries.filter((entry) => entry.status === 'unleased-in-range');
  if (unleased.length > 0) {
    lines.push('Unleased in range');
    for (const entry of unleased) {
      if (entry.listener) lines.push(`  ${String(entry.port).padEnd(width)}  ${describeListener(entry.listener)} ${whereFrom(entry.listener.cwd)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function scan(args: string[], io: Io): Promise<number> {
  if (io.platform === 'win32') throw new PortleaseError('scan is not supported on Windows', ExitCode.usage);
  const { values, positionals } = parseOrUsage(() =>
    parseArgs({ args, strict: true, allowPositionals: true, options: { json: { type: 'boolean' } } }),
  );
  if (positionals.length > 1) throw new PortleaseError('scan takes at most one port', ExitCode.usage);
  const port = positionals[0] === undefined ? undefined : parsePort(positionals[0]);

  const home = registryHome(io.env);
  const { range } = readConfig(home);
  const { leases } = readRegistry(home, range);
  const listeners = await io.listListeners();
  let entries: ScanEntry[];
  if (listeners === null) {
    io.stderr('lsof not available: showing only whether leased ports are in use, not who holds them\n');
    entries = await probeLeases(leases, port);
  } else {
    entries = await confirmFree(classify({ leases, listeners, range, ...(port === undefined ? {} : { port }) }), port);
  }

  io.stdout(values.json ? `${JSON.stringify(entries, null, 2)}\n` : formatScan(entries, port, listeners !== null));
  return ExitCode.ok;
}

export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const [command, ...rest] = argv;
    switch (command) {
      case 'claim':
        return await claim(rest, io);
      case 'release':
        return await release(rest, io);
      case 'ls':
        return ls(rest, io);
      case 'scan':
        return await scan(rest, io);
      case '-h':
      case '--help':
        io.stdout(USAGE);
        return ExitCode.ok;
      default:
        throw new PortleaseError(command ? `unknown command "${command}"` : 'missing command', ExitCode.usage);
    }
  } catch (error) {
    if (error instanceof PortleaseError) {
      io.stderr(`portlease: ${error.message}\n`);
      if (error.exitCode === ExitCode.usage) io.stderr(USAGE);
      return error.exitCode;
    }
    io.stderr(`portlease: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return ExitCode.usage;
  }
}
