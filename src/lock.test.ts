import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExitCode, PortleaseError } from './errors.ts';
import { LOCK_FILE, withLock } from './lock.ts';

const tempHome = () => mkdtempSync(join(tmpdir(), 'portlease-lock-'));

const deadPid = () => {
  const result = spawnSync(process.execPath, ['-e', '']);
  assert.ok(result.pid);
  return result.pid;
};

describe('withLock', () => {
  test('returns the result and removes the lock afterwards', async () => {
    const home = tempHome();
    assert.equal(await withLock(home, async () => 42), 42);
    assert.equal(existsSync(join(home, LOCK_FILE)), false);
  });

  test('creates the home directory when missing', async () => {
    const home = join(tempHome(), 'nested');
    await withLock(home, async () => undefined);
    assert.equal(existsSync(home), true);
  });

  test('an unusable home directory is a registry error, not a crash', async () => {
    const file = join(tempHome(), 'file');
    writeFileSync(file, '');
    await assert.rejects(
      withLock(join(file, 'nested'), async () => 1),
      (error: unknown) => error instanceof PortleaseError && error.exitCode === ExitCode.registry,
    );
  });

  test('several waiters over one stale lock never overlap', async () => {
    const home = tempHome();
    writeFileSync(join(home, LOCK_FILE), JSON.stringify({ pid: deadPid(), token: 'old', startedAt: '2026-01-01T00:00:00.000Z' }));
    let inside = 0;
    let overlaps = 0;
    const work = async () => {
      inside++;
      if (inside > 1) overlaps++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      inside--;
    };
    await Promise.all(Array.from({ length: 8 }, () => withLock(home, work, { retryMs: 2 })));
    assert.equal(overlaps, 0);
  });

  test('removes the lock when the work fails', async () => {
    const home = tempHome();
    await assert.rejects(withLock(home, async () => Promise.reject(new Error('boom'))), /boom/);
    assert.equal(existsSync(join(home, LOCK_FILE)), false);
  });

  test('runs one holder at a time', async () => {
    const home = tempHome();
    const events: string[] = [];
    const work = (label: string) => async () => {
      events.push(`${label} start`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      events.push(`${label} end`);
    };
    await Promise.all([withLock(home, work('a'), { retryMs: 5 }), withLock(home, work('b'), { retryMs: 5 })]);
    assert.deepEqual(events, ['a start', 'a end', 'b start', 'b end']);
  });

  test('takes over a lock whose process is gone', async () => {
    const home = tempHome();
    writeFileSync(join(home, LOCK_FILE), JSON.stringify({ pid: deadPid(), token: 'old', startedAt: '2026-01-01T00:00:00.000Z' }));
    assert.equal(await withLock(home, async () => 'ok', { timeoutMs: 500 }), 'ok');
  });

  test('times out on a lock held by a live process, naming its PID', async () => {
    const home = tempHome();
    const lock = join(home, LOCK_FILE);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other', startedAt: new Date().toISOString() }));
    await assert.rejects(
      withLock(home, async () => 'never', { timeoutMs: 200, retryMs: 20 }),
      (error: unknown) =>
        error instanceof PortleaseError &&
        error.exitCode === ExitCode.lockTimeout &&
        error.message.includes(`PID ${process.pid}`),
    );
    assert.equal(existsSync(lock), true);
  });

  test('waits on a fresh unreadable lock, since its owner may still be writing it', async () => {
    const home = tempHome();
    writeFileSync(join(home, LOCK_FILE), '');
    await assert.rejects(
      withLock(home, async () => 'never', { timeoutMs: 200, retryMs: 20 }),
      (error: unknown) => error instanceof PortleaseError && error.exitCode === ExitCode.lockTimeout,
    );
  });

  test('takes over an unreadable lock older than the timeout', async () => {
    const home = tempHome();
    const lock = join(home, LOCK_FILE);
    writeFileSync(lock, '');
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lock, longAgo, longAgo);
    assert.equal(await withLock(home, async () => 'ok', { timeoutMs: 500 }), 'ok');
  });
});
