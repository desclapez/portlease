import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExitCode, PortleaseError } from './errors.ts';
import {
  DEFAULT_RANGE,
  emptyRegistry,
  pruneMissingDirs,
  readConfig,
  readRegistry,
  saveRegistry,
  type Registry,
} from './registry.ts';

const tempHome = () => mkdtempSync(join(tmpdir(), 'portlease-registry-'));

const registryError = (pattern: RegExp) => (error: unknown) =>
  error instanceof PortleaseError && error.exitCode === ExitCode.registry && pattern.test(error.message);

const sample: Registry = {
  version: 1,
  cursor: 21002,
  leases: [
    { dir: '/repos/app', name: 'WEB_PORT', port: 21000, claimedAt: '2026-10-12T10:03:00.000Z' },
    { dir: '/repos/app', name: 'API_PORT', port: 21001, claimedAt: '2026-10-12T10:03:00.000Z' },
  ],
};

describe('readConfig', () => {
  test('a missing file gives the default range', () => {
    assert.deepEqual(readConfig(tempHome()), { range: DEFAULT_RANGE });
  });

  test('an object without a range gives the default range', () => {
    const home = tempHome();
    writeFileSync(join(home, 'config.json'), '{}');
    assert.deepEqual(readConfig(home), { range: DEFAULT_RANGE });
  });

  test('reads a custom range', () => {
    const home = tempHome();
    writeFileSync(join(home, 'config.json'), '{ "range": { "min": 30000, "max": 30099 } }');
    assert.deepEqual(readConfig(home), { range: { min: 30000, max: 30099 } });
  });

  test('rejects a range whose min is above its max', () => {
    const home = tempHome();
    writeFileSync(join(home, 'config.json'), '{ "range": { "min": 30099, "max": 30000 } }');
    assert.throws(() => readConfig(home), registryError(/"range" must be/));
  });
});

describe('readRegistry', () => {
  test('a missing file gives an empty registry starting at the range minimum', () => {
    assert.deepEqual(readRegistry(tempHome(), DEFAULT_RANGE), emptyRegistry(DEFAULT_RANGE));
    assert.deepEqual(emptyRegistry(DEFAULT_RANGE), { version: 1, cursor: 20000, leases: [] });
  });

  test('round-trips through saveRegistry without leaving temp files', () => {
    const home = tempHome();
    saveRegistry(home, sample);
    assert.deepEqual(readRegistry(home, DEFAULT_RANGE), sample);
    assert.deepEqual(readdirSync(home), ['leases.json']);
  });

  test('saveRegistry creates the home directory when missing', () => {
    const home = join(tempHome(), 'nested', 'portlease');
    saveRegistry(home, sample);
    assert.deepEqual(readRegistry(home, DEFAULT_RANGE), sample);
  });

  test('a failed save leaves no temp file behind', () => {
    const home = tempHome();
    mkdirSync(join(home, 'leases.json'));
    assert.throws(() => saveRegistry(home, sample), registryError(/cannot save/));
    assert.deepEqual(readdirSync(home), ['leases.json']);
  });

  test('rejects a version below 1', () => {
    const home = tempHome();
    writeFileSync(join(home, 'leases.json'), '{ "version": 0, "cursor": 20000, "leases": [] }');
    assert.throws(() => readRegistry(home, DEFAULT_RANGE), registryError(/malformed/));
  });

  test('rejects invalid JSON', () => {
    const home = tempHome();
    writeFileSync(join(home, 'leases.json'), '{ not json');
    assert.throws(() => readRegistry(home, DEFAULT_RANGE), registryError(/not valid JSON/));
  });

  test('refuses a newer format and leaves the file untouched', () => {
    const home = tempHome();
    const file = join(home, 'leases.json');
    const newer = '{ "version": 2, "cursor": 20000, "leases": [], "owners": {} }';
    writeFileSync(file, newer);
    assert.throws(() => readRegistry(home, DEFAULT_RANGE), registryError(/version 2.*Upgrade portlease/));
    assert.equal(readFileSync(file, 'utf8'), newer);
  });

  test('rejects a malformed lease', () => {
    const home = tempHome();
    writeFileSync(
      join(home, 'leases.json'),
      JSON.stringify({ version: 1, cursor: 20000, leases: [{ dir: '/repos/app', name: 'WEB_PORT', port: 'x' }] }),
    );
    assert.throws(() => readRegistry(home, DEFAULT_RANGE), registryError(/malformed/));
  });

  test('rejects a port that appears twice', () => {
    const home = tempHome();
    const lease = sample.leases[0]!;
    writeFileSync(
      join(home, 'leases.json'),
      JSON.stringify({ ...sample, leases: [lease, { ...lease, dir: '/repos/other' }] }),
    );
    assert.throws(() => readRegistry(home, DEFAULT_RANGE), registryError(/inconsistent/));
  });

  test('rejects a directory and name pair that appears twice', () => {
    const home = tempHome();
    const lease = sample.leases[0]!;
    writeFileSync(join(home, 'leases.json'), JSON.stringify({ ...sample, leases: [lease, { ...lease, port: 21005 }] }));
    assert.throws(() => readRegistry(home, DEFAULT_RANGE), registryError(/inconsistent/));
  });
});

describe('pruneMissingDirs', () => {
  test('drops the leases of directories that no longer exist', () => {
    const withOther: Registry = {
      ...sample,
      leases: [...sample.leases, { dir: '/repos/gone', name: 'WEB_PORT', port: 21009, claimedAt: '2026-10-12T10:03:00.000Z' }],
    };
    assert.deepEqual(pruneMissingDirs(withOther, (dir) => dir !== '/repos/gone'), sample);
  });
});
