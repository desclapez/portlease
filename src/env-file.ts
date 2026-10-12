import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { ExitCode, PortleaseError } from './errors.ts';

export type EnvChange =
  | { kind: 'replace'; name: string; before: string; after: string }
  | { kind: 'append'; name: string; after: string };

// Names are validated against NAME_PATTERN before reaching here, so they need no escaping.
const assignmentPattern = (name: string) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);

const assignment = (name: string, port: number, exported: boolean) => `${exported ? 'export ' : ''}${name}=${port}`;

function splitLines(content: string): string[] {
  return content === '' ? [] : content.split(/(?<=\n)/);
}

function splitEnding(line: string): { body: string; ending: string } {
  const ending = /\r?\n$/.exec(line)?.[0] ?? '';
  return { body: line.slice(0, line.length - ending.length), ending };
}

export function rewriteEnv(content: string, values: ReadonlyMap<string, number>): string {
  const written = new Set<string>();
  const lines = splitLines(content).map((line) => {
    const { body, ending } = splitEnding(line);
    for (const [name, port] of values) {
      const match = assignmentPattern(name).exec(body);
      if (match) {
        written.add(name);
        return `${assignment(name, port, match[1] !== undefined)}${ending}`;
      }
    }
    return line;
  });

  let result = lines.join('');
  const missing = [...values].filter(([name]) => !written.has(name));
  if (missing.length > 0) {
    if (result !== '' && !result.endsWith('\n')) result += '\n';
    result += missing.map(([name, port]) => `${assignment(name, port, false)}\n`).join('');
  }
  return result;
}

export function diffEnv(content: string, values: ReadonlyMap<string, number>): EnvChange[] {
  const bodies = splitLines(content).map((line) => splitEnding(line).body);
  const changes: EnvChange[] = [];
  for (const [name, port] of values) {
    const pattern = assignmentPattern(name);
    const existing = bodies.filter((body) => pattern.test(body));
    if (existing.length === 0) {
      changes.push({ kind: 'append', name, after: assignment(name, port, false) });
      continue;
    }
    for (const before of existing) {
      const after = assignment(name, port, pattern.exec(before)?.[1] !== undefined);
      if (before !== after) changes.push({ kind: 'replace', name, before, after });
    }
  }
  return changes;
}

export function readEnvFile(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new PortleaseError(`cannot read env file ${file}: ${(error as Error).message}`, ExitCode.envWrite);
  }
}

export function writeEnvFile(file: string, values: ReadonlyMap<string, number>): void {
  const target = existsSync(file) ? realpathSync(file) : file;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  const temp = `${target}.portlease-${process.pid}.tmp`;
  try {
    writeFileSync(temp, rewriteEnv(readEnvFile(target), values), { mode });
    chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // the temp file was never created
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new PortleaseError(
      `cannot write env file ${file}: ${reason}. The ports are leased; run claim again once the file is writable`,
      ExitCode.envWrite,
    );
  }
}
