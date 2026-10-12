import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { leaseNames, type LeaseResult } from './claim.ts';
import { diffEnv, readEnvFile, writeEnvFile, type EnvChange } from './env-file.ts';
import { ExitCode, PortleaseError } from './errors.ts';
import { isPortFree } from './free-port.ts';
import { withLock } from './lock.ts';
import { canonicalPath, registryHome } from './paths.ts';
import { readPortsFile } from './ports-file.ts';
import { pruneMissingDirs, readConfig, readRegistry, saveRegistry } from './registry.ts';

export type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

const USAGE = `Usage:
  portlease claim --ports <file> --env <file> [--dir <dir>] [--dry-run]
  portlease release [--dir <dir>]
  portlease ls [--json]
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

const toValues = (results: LeaseResult[]) => new Map(results.map(({ name, port }) => [name, port]));

function formatDryRun(dir: string, envLabel: string, results: LeaseResult[], changes: EnvChange[]): string {
  const lines = [`Dry run for ${dir}: nothing was written.`, ''];
  for (const { name, port, reused } of results) {
    lines.push(`  ${name}=${port}  ${reused ? 'existing lease' : 'new lease (tentative)'}`);
  }
  lines.push('');
  if (changes.length === 0) {
    lines.push(`${envLabel}: no changes`);
  } else {
    lines.push(`${envLabel}:`);
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
        ports: { type: 'string' },
        env: { type: 'string' },
        dir: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
    }),
  );
  if (!values.ports) throw new PortleaseError('missing --ports <file>', ExitCode.usage);
  if (!values.env) throw new PortleaseError('missing --env <file>', ExitCode.usage);

  const names = readPortsFile(resolve(io.cwd, values.ports));
  const dir = canonicalPath(resolve(io.cwd, values.dir ?? '.'));
  if (!isDirectory(dir)) throw new PortleaseError(`${dir} is not an existing directory`, ExitCode.usage);
  const envFile = resolve(io.cwd, values.env);
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
    const { results } = await plan();
    io.stdout(formatDryRun(dir, values.env, results, diffEnv(readEnvFile(envFile), toValues(results))));
    return ExitCode.ok;
  }

  const { results } = await withLock(home, async () => {
    const outcome = await plan();
    saveRegistry(home, outcome.registry);
    return outcome;
  });
  writeEnvFile(envFile, toValues(results));
  io.stderr(`Leased for ${dir}:\n`);
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
