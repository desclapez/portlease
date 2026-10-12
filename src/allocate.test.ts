import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { allocatePort, type Range } from './allocate.ts';
import { ExitCode, PortleaseError } from './errors.ts';

const range: Range = { min: 20000, max: 20009 };
const allFree = async () => true;

describe('allocatePort', () => {
  test('starts at the cursor and moves the cursor past the port', async () => {
    assert.deepEqual(await allocatePort({ range, cursor: 20003, taken: new Set(), isFree: allFree }), {
      port: 20003,
      cursor: 20004,
    });
  });

  test('skips leased ports without probing them', async () => {
    const probed: number[] = [];
    const isFree = async (port: number) => {
      probed.push(port);
      return true;
    };
    const allocation = await allocatePort({ range, cursor: 20003, taken: new Set([20003]), isFree });
    assert.equal(allocation.port, 20004);
    assert.deepEqual(probed, [20004]);
  });

  test('skips ports that are busy right now', async () => {
    const isFree = async (port: number) => port !== 20003;
    assert.equal((await allocatePort({ range, cursor: 20003, taken: new Set(), isFree })).port, 20004);
  });

  test('wraps the cursor to the start of the range after the last port', async () => {
    assert.deepEqual(await allocatePort({ range, cursor: 20009, taken: new Set(), isFree: allFree }), {
      port: 20009,
      cursor: 20000,
    });
  });

  test('wraps the search to the start of the range', async () => {
    assert.equal((await allocatePort({ range, cursor: 20009, taken: new Set([20009]), isFree: allFree })).port, 20000);
  });

  test('starts at the range minimum when the cursor is outside the range', async () => {
    assert.equal((await allocatePort({ range, cursor: 31000, taken: new Set(), isFree: allFree })).port, 20000);
  });

  test('fails with range exhausted when every port is taken or busy', async () => {
    const taken = new Set([20000, 20001, 20002, 20003, 20004]);
    const isFree = async (port: number) => port < 20005;
    await assert.rejects(
      allocatePort({ range, cursor: 20000, taken, isFree }),
      (error: unknown) =>
        error instanceof PortleaseError && error.exitCode === ExitCode.rangeExhausted && /20000 and 20009/.test(error.message),
    );
  });
});
