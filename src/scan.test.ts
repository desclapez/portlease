import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Range } from './allocate.ts';
import type { Listener } from './listeners.ts';
import type { Lease } from './registry.ts';
import { classify, owner } from './scan.ts';

const range: Range = { min: 20000, max: 29999 };
const claimedAt = '2026-11-08T10:00:00.000Z';
const lease = (dir: string, name: string, port: number): Lease => ({ dir, name, port, claimedAt });
const listener = (port: number, cwd: string | null, pid = 100, command = 'node'): Listener => ({ port, pid, command, cwd });

const leases = [lease('/w/a', 'WEB_PORT', 20000), lease('/w/a', 'API_PORT', 20001), lease('/w/b', 'WEB_PORT', 20002)];

describe('classify', () => {
  test('a leased port nobody listens on is free', () => {
    assert.deepEqual(classify({ leases: [lease('/w/a', 'WEB_PORT', 20000)], listeners: [], range }), [
      { port: 20000, lease: { dir: '/w/a', name: 'WEB_PORT' }, listener: null, ownerDir: null, status: 'free' },
    ]);
  });

  test('a leased port held from its own directory or a subdirectory is ok', () => {
    const entries = classify({ leases, listeners: [listener(20000, '/w/a/apps/web', 7), listener(20001, '/w/a', 8)], range });
    assert.deepEqual(entries.slice(0, 2), [
      {
        port: 20000,
        lease: { dir: '/w/a', name: 'WEB_PORT' },
        listener: { pid: 7, command: 'node', cwd: '/w/a/apps/web' },
        ownerDir: '/w/a',
        status: 'ok',
      },
      {
        port: 20001,
        lease: { dir: '/w/a', name: 'API_PORT' },
        listener: { pid: 8, command: 'node', cwd: '/w/a' },
        ownerDir: '/w/a',
        status: 'ok',
      },
    ]);
  });

  test('a leased port held from elsewhere is held-by-other', () => {
    const entries = classify({ leases, listeners: [listener(20000, '/w/b', 9, 'python')], range });
    assert.deepEqual(entries[0], {
      port: 20000,
      lease: { dir: '/w/a', name: 'WEB_PORT' },
      listener: { pid: 9, command: 'python', cwd: '/w/b' },
      ownerDir: null,
      status: 'held-by-other',
    });
  });

  test('a listener with an unknown directory on a leased port is held-by-other', () => {
    const entries = classify({ leases, listeners: [listener(20000, null)], range });
    assert.equal(entries[0]?.status, 'held-by-other');
    assert.equal(entries[0]?.listener?.cwd, null);
  });

  test('several listeners on one leased port give one entry each', () => {
    const entries = classify({ leases, listeners: [listener(20000, '/w/a', 1), listener(20000, '/x', 2)], range });
    assert.deepEqual(
      entries.filter((entry) => entry.port === 20000).map((entry) => [entry.listener?.pid, entry.status]),
      [
        [1, 'ok'],
        [2, 'held-by-other'],
      ],
    );
  });

  test('a copy listening on a port it has not leased is not-leased, whatever the number', () => {
    const entries = classify({ leases, listeners: [listener(4001, '/w/a', 5), listener(20500, '/w/a/apps', 6)], range });
    const flagged = entries.filter((entry) => entry.status === 'not-leased');
    assert.deepEqual(flagged, [
      { port: 4001, lease: null, listener: { pid: 5, command: 'node', cwd: '/w/a' }, ownerDir: '/w/a', status: 'not-leased' },
      { port: 20500, lease: null, listener: { pid: 6, command: 'node', cwd: '/w/a/apps' }, ownerDir: '/w/a', status: 'not-leased' },
    ]);
  });

  test("a copy listening on another copy's leased port is flagged under both", () => {
    const entries = classify({ leases, listeners: [listener(20002, '/w/a', 5)], range });
    const statuses = entries.filter((entry) => entry.port === 20002).map((entry) => [entry.lease?.dir ?? entry.ownerDir, entry.status]);
    assert.deepEqual(statuses, [
      ['/w/b', 'held-by-other'],
      ['/w/a', 'not-leased'],
    ]);
  });

  test('noise outside the range is ignored', () => {
    const entries = classify({ leases, listeners: [listener(5000, '/'), listener(7000, null)], range });
    assert.deepEqual(
      entries.map((entry) => entry.status),
      ['free', 'free', 'free'],
    );
  });

  test('an unknown listener inside the range is unleased-in-range', () => {
    const entries = classify({ leases, listeners: [listener(20500, '/'), listener(20600, null)], range });
    assert.deepEqual(
      entries.filter((entry) => entry.status === 'unleased-in-range').map((entry) => entry.port),
      [20500, 20600],
    );
    assert.equal(entries.at(-1)?.lease, null);
    assert.equal(entries.at(-1)?.ownerDir, null);
  });

  test('entries are ordered: leases by dir and port, then not-leased, then unleased-in-range', () => {
    const shuffled = [lease('/w/b', 'WEB_PORT', 20002), lease('/w/a', 'API_PORT', 20001), lease('/w/a', 'WEB_PORT', 20000)];
    const entries = classify({
      leases: shuffled,
      listeners: [listener(20700, '/'), listener(3000, '/w/b'), listener(4000, '/w/a'), listener(20600, '/')],
      range,
    });
    assert.deepEqual(
      entries.map((entry) => `${entry.port}:${entry.status}`),
      ['20000:free', '20001:free', '20002:free', '4000:not-leased', '3000:not-leased', '20600:unleased-in-range', '20700:unleased-in-range'],
    );
  });

  test('filtered by port: only that port; an unrelated holder is unleased', () => {
    const listeners = [listener(5000, '/', 3, 'ControlCenter'), listener(4001, '/w/a', 4)];
    assert.deepEqual(classify({ leases, listeners, range, port: 5000 }), [
      { port: 5000, lease: null, listener: { pid: 3, command: 'ControlCenter', cwd: '/' }, ownerDir: null, status: 'unleased' },
    ]);
    assert.deepEqual(classify({ leases, listeners, range, port: 5001 }), []);
    assert.deepEqual(
      classify({ leases, listeners, range, port: 20001 }).map((entry) => entry.status),
      ['free'],
    );
    assert.deepEqual(
      classify({ leases, listeners, range, port: 4001 }).map((entry) => entry.status),
      ['not-leased'],
    );
  });
});

describe('owner', () => {
  test('nested leased directories: the deepest owns', () => {
    assert.equal(owner('/w/a/sub/x', ['/w/a', '/w/a/sub']), '/w/a/sub');
    assert.equal(owner('/w/a/x', ['/w/a/sub', '/w/a']), '/w/a');
    assert.equal(owner('/w/a', ['/w/a']), '/w/a');
  });

  test('a sibling with a common prefix does not belong', () => {
    assert.equal(owner('/w/ab', ['/w/a']), null);
    assert.equal(owner(null, ['/w/a']), null);
  });
});
