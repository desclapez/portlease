import { randomUUID } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ExitCode, PortleaseError } from './errors.ts';

export const LOCK_FILE = 'leases.lock';

// An unreadable lock only counts as stale once it is older than this, whatever timeout one caller uses.
const UNREADABLE_STALE_MS = 10_000;

export type LockOptions = { timeoutMs?: number; retryMs?: number };

type Inspection = { kind: 'gone' } | { kind: 'stale'; text: string } | { kind: 'held'; pid: number } | { kind: 'pending' };

function tryAcquire(file: string, token: string): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw new PortleaseError(`cannot create lock ${file}: ${(error as Error).message}`, ExitCode.registry);
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
  return true;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parsePid(text: string): number | undefined {
  try {
    const { pid } = JSON.parse(text) as { pid?: unknown };
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function inspect(file: string, staleAfterMs: number): Inspection {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { kind: 'gone' };
  }
  const pid = parsePid(text);
  if (pid !== undefined) return isAlive(pid) ? { kind: 'held', pid } : { kind: 'stale', text };
  // No readable owner: it may still be writing the file, so it only counts as stale once old.
  try {
    return Date.now() - statSync(file).mtimeMs > staleAfterMs ? { kind: 'stale', text } : { kind: 'pending' };
  } catch {
    return { kind: 'gone' };
  }
}

// Only removes the file if it still holds what we expect, so we never delete a lock someone else just took.
function removeIf(file: string, expected: (text: string) => boolean): void {
  try {
    if (expected(readFileSync(file, 'utf8'))) unlinkSync(file);
  } catch {
    // already gone
  }
}

// Taking over a stale lock must not delete one that someone else just created. Reading then deleting leaves a gap,
// so move the file aside first (atomic), check what we moved, and put it back if it was not the stale one.
function removeStale(file: string, staleText: string): void {
  const aside = `${file}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(file, aside);
  } catch {
    return; // already gone
  }
  try {
    const moved = readFileSync(aside, 'utf8');
    // An empty file looks the same whether it is a crashed leftover or a lock being written: tell them apart by age.
    const stillStale = moved === staleText && (moved !== '' || Date.now() - statSync(aside).mtimeMs > UNREADABLE_STALE_MS);
    if (!stillStale) {
      // A live (or still-being-written) lock: restore it unless a newer one already took its place.
      try {
        linkSync(aside, file);
      } catch {
        // someone else holds the lock path now
      }
    }
  } finally {
    unlinkSync(aside);
  }
}

export async function withLock<T>(home: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryMs = options.retryMs ?? 50;
  mkdirSync(home, { recursive: true });
  const file = join(home, LOCK_FILE);
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;

  while (!tryAcquire(file, token)) {
    const found = inspect(file, UNREADABLE_STALE_MS);
    if (found.kind === 'gone') continue;
    if (found.kind === 'stale') {
      removeStale(file, found.text);
      continue;
    }
    if (Date.now() >= deadline) {
      const owner = found.kind === 'held' ? `PID ${found.pid}` : 'another process';
      throw new PortleaseError(
        `the registry is locked by ${owner} (waited ${timeoutMs / 1000}s). If no portlease is running, delete ${file}`,
        ExitCode.lockTimeout,
      );
    }
    await sleep(retryMs);
  }

  try {
    return await fn();
  } finally {
    removeIf(file, (text) => text.includes(token));
  }
}
