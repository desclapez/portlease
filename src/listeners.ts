import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { canonicalPath } from './paths.ts';

export type Listener = { port: number; pid: number; command: string; cwd: string | null };

type Listening = { port: number; pid: number; command: string };

// `null` when lsof cannot be run.
export type RunLsof = (args: string[]) => Promise<string | null>;

// lsof -F prints one field per line: a type letter, then the value. `p` starts a process.
function* fields(text: string): Generator<{ type: string; value: string }> {
  for (const line of text.split('\n')) {
    if (line !== '') yield { type: line[0] as string, value: line.slice(1) };
  }
}

export function parseListening(text: string): Listening[] {
  const seen = new Set<string>();
  const listening: Listening[] = [];
  let pid: number | undefined;
  let command = '';
  for (const { type, value } of fields(text)) {
    if (type === 'p') {
      pid = Number(value);
      command = '';
    } else if (type === 'c') {
      command = value;
    } else if (type === 'n' && pid !== undefined) {
      const port = /:(\d+)$/.exec(value)?.[1];
      if (port === undefined) continue;
      // One server bound on IPv4 and IPv6 shows up twice.
      const key = `${port}:${pid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      listening.push({ port: Number(port), pid, command });
    }
  }
  return listening.sort((a, b) => a.port - b.port || a.pid - b.pid);
}

export function parseCwds(text: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | undefined;
  for (const { type, value } of fields(text)) {
    if (type === 'p') pid = Number(value);
    else if (type === 'n' && pid !== undefined) cwds.set(pid, value);
  }
  return cwds;
}

// lsof exits 1 both when nothing matched (no output, no message) and when a -p process went away
// (partial output); only a missing binary or a failure with a message means it is unavailable.
export function lsofOutput(error: (Error & { code?: unknown }) | null, stdout: string, stderr: string): string | null {
  if (!error) return stdout;
  if (typeof error.code !== 'number') return null;
  if (stdout !== '') return stdout;
  return stderr.trim() === '' ? '' : null;
}

export const defaultRunLsof: RunLsof = (args) =>
  new Promise((resolve) => {
    execFile('lsof', args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve(lsofOutput(error, stdout, stderr));
    });
  });

// Path of the executable behind a pid, or null when it cannot be read (not Linux, another user, gone).
export type ReadExe = (pid: number) => Promise<string | null>;

export const defaultReadExe: ReadExe = (pid) => readlink(`/proc/${pid}/exe`).catch(() => null);

// Node 24 on Linux names its main thread "MainThread", and lsof reports the thread name as the command.
// The executable name is what the user recognises.
async function realCommand(command: string, pid: number, readExe: ReadExe): Promise<string> {
  if (command !== 'MainThread') return command;
  const exe = await readExe(pid);
  return exe === null ? command : basename(exe.replace(/ \(deleted\)$/, ''));
}

export async function listListeners(
  runLsof: RunLsof = defaultRunLsof,
  readExe: ReadExe = defaultReadExe,
): Promise<Listener[] | null> {
  const output = await runLsof(['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']);
  if (output === null) return null;
  const listening = parseListening(output);
  if (listening.length === 0) return [];

  const pids = [...new Set(listening.map((listener) => listener.pid))].sort((a, b) => a - b);
  const cwds = parseCwds((await runLsof(['-a', '-p', pids.join(','), '-d', 'cwd', '-F', 'pn'])) ?? '');
  return Promise.all(
    listening.map(async (listener) => {
      const cwd = cwds.get(listener.pid);
      return {
        ...listener,
        command: await realCommand(listener.command, listener.pid, readExe),
        cwd: cwd === undefined ? null : canonicalPath(cwd),
      };
    }),
  );
}
