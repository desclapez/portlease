import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Range } from './allocate.ts';
import { leaseNames } from './claim.ts';
import { ExitCode, PortleaseError } from './errors.ts';
import type { Registry } from './registry.ts';

const range: Range = { min: 20000, max: 20009 };
const now = new Date('2026-10-12T10:00:00.000Z');
const allFree = async () => true;
const empty = (): Registry => ({ version: 1, cursor: 20000, leases: [] });

describe('leaseNames', () => {
  test('leases new names from the cursor, in order', async () => {
    const { registry, results, released } = await leaseNames({
      registry: empty(),
      dir: '/repos/app',
      names: ['WEB_PORT', 'API_PORT'],
      range,
      isFree: allFree,
      now,
    });
    assert.deepEqual(results, [
      { name: 'WEB_PORT', port: 20000, reused: false },
      { name: 'API_PORT', port: 20001, reused: false },
    ]);
    assert.equal(registry.cursor, 20002);
    assert.deepEqual(released, []);
    assert.deepEqual(registry.leases, [
      { dir: '/repos/app', name: 'WEB_PORT', port: 20000, claimedAt: '2026-10-12T10:00:00.000Z' },
      { dir: '/repos/app', name: 'API_PORT', port: 20001, claimedAt: '2026-10-12T10:00:00.000Z' },
    ]);
  });

  test('reuses an existing lease and only adds the new name', async () => {
    const first = await leaseNames({ registry: empty(), dir: '/repos/app', names: ['WEB_PORT'], range, isFree: allFree, now });
    const later = new Date('2026-10-13T10:00:00.000Z');
    const second = await leaseNames({
      registry: first.registry,
      dir: '/repos/app',
      names: ['WEB_PORT', 'API_PORT'],
      range,
      isFree: allFree,
      now: later,
    });
    assert.deepEqual(second.results, [
      { name: 'WEB_PORT', port: 20000, reused: true },
      { name: 'API_PORT', port: 20001, reused: false },
    ]);
    assert.equal(second.registry.leases[0]?.claimedAt, '2026-10-12T10:00:00.000Z');
    assert.deepEqual(second.released, []);
  });

  test('gives the same name in another directory a different port', async () => {
    const first = await leaseNames({ registry: empty(), dir: '/repos/app', names: ['WEB_PORT'], range, isFree: allFree, now });
    const second = await leaseNames({
      registry: first.registry,
      dir: '/repos/app-feat-x',
      names: ['WEB_PORT'],
      range,
      isFree: allFree,
      now,
    });
    assert.deepEqual(second.results, [{ name: 'WEB_PORT', port: 20001, reused: false }]);
    assert.deepEqual(second.released, []);
  });

  test('fails on an exhausted range and leaves the input registry untouched', async () => {
    const tiny: Range = { min: 20000, max: 20000 };
    const registry = empty();
    await assert.rejects(
      leaseNames({ registry, dir: '/repos/app', names: ['WEB_PORT', 'API_PORT'], range: tiny, isFree: allFree, now }),
      (error: unknown) => error instanceof PortleaseError && error.exitCode === ExitCode.rangeExhausted,
    );
    assert.deepEqual(registry, empty());
  });
  test('releases leases of the directory whose name is no longer listed', async () => {
    const claimedAt = '2026-10-01T10:00:00.000Z';
    const registry: Registry = {
      version: 1,
      cursor: 20003,
      leases: [
        { dir: '/repos/app', name: 'OLD_PORT', port: 20000, claimedAt },
        { dir: '/repos/app', name: 'WEB_PORT', port: 20001, claimedAt },
        { dir: '/repos/other', name: 'OLD_PORT', port: 20002, claimedAt },
      ],
    };
    const outcome = await leaseNames({ registry, dir: '/repos/app', names: ['WEB_PORT'], range, isFree: allFree, now });
    assert.deepEqual(outcome.released, [{ dir: '/repos/app', name: 'OLD_PORT', port: 20000, claimedAt }]);
    assert.deepEqual(outcome.registry.leases, [
      { dir: '/repos/app', name: 'WEB_PORT', port: 20001, claimedAt },
      { dir: '/repos/other', name: 'OLD_PORT', port: 20002, claimedAt },
    ]);
    assert.deepEqual(outcome.results, [{ name: 'WEB_PORT', port: 20001, reused: true }]);
  });

  test('a freed port is not handed to a new name in the same claim', async () => {
    const registry: Registry = {
      version: 1,
      cursor: 20000,
      leases: [{ dir: '/repos/app', name: 'OLD_PORT', port: 20000, claimedAt: '2026-10-01T10:00:00.000Z' }],
    };
    const outcome = await leaseNames({ registry, dir: '/repos/app', names: ['NEW_PORT'], range, isFree: allFree, now });
    assert.deepEqual(outcome.results, [{ name: 'NEW_PORT', port: 20001, reused: false }]);
    assert.deepEqual(outcome.registry.leases.map((lease) => lease.name), ['NEW_PORT']);
  });
});
