import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { lsofOutput, listListeners, parseCwds, parseListening, type RunLsof } from './listeners.ts';

// Real `lsof -F pcn` output also carries `f` (file descriptor) lines, which the parser skips.
const LISTENING = 'p1129\ncControlCenter\nf8\nn*:5000\nf9\nn*:7000\np1519\ncollama\nf3\nn127.0.0.1:11434\np79986\ncnode\nf20\nn[::1]:6006\n';

describe('parseListening', () => {
  test('parses ports of every address form', () => {
    assert.deepEqual(parseListening(LISTENING), [
      { port: 5000, pid: 1129, command: 'ControlCenter' },
      { port: 6006, pid: 79986, command: 'node' },
      { port: 7000, pid: 1129, command: 'ControlCenter' },
      { port: 11434, pid: 1519, command: 'ollama' },
    ]);
  });

  test('a server on IPv4 and IPv6 is listed once', () => {
    assert.deepEqual(parseListening('p42\ncnode\nn127.0.0.1:20017\nn[::1]:20017\n'), [{ port: 20017, pid: 42, command: 'node' }]);
  });

  test('skips names without a port and empty output', () => {
    assert.deepEqual(parseListening('p42\ncnode\nnsomething\n'), []);
    assert.deepEqual(parseListening(''), []);
  });
});

describe('parseCwds', () => {
  test('parses working directories', () => {
    assert.deepEqual(
      parseCwds('p79980\nfcwd\nn/Users/x/a\np79986\nfcwd\nn/Users/x/b\n'),
      new Map([
        [79980, '/Users/x/a'],
        [79986, '/Users/x/b'],
      ]),
    );
  });
});

describe('lsofOutput', () => {
  test('success is the output', () => {
    assert.equal(lsofOutput(null, 'p1\n', ''), 'p1\n');
  });

  test('a non-zero exit with output still counts (a -p process went away)', () => {
    assert.equal(lsofOutput(Object.assign(new Error('exit 1'), { code: 1 }), 'p1\n', ''), 'p1\n');
  });

  test('a non-zero exit with no output and no message means nothing matched', () => {
    assert.equal(lsofOutput(Object.assign(new Error('exit 1'), { code: 1 }), '', ''), '');
  });

  test('lsof missing or failing with a message is unavailable', () => {
    assert.equal(lsofOutput(Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }), '', ''), null);
    assert.equal(lsofOutput(Object.assign(new Error('exit 1'), { code: 1 }), '', 'lsof: permission denied\n'), null);
  });
});

describe('listListeners', () => {
  test('joins both calls and leaves unknown directories as null', async () => {
    const calls: string[][] = [];
    const runLsof: RunLsof = async (args) => {
      calls.push(args);
      return calls.length === 1 ? LISTENING : 'p79986\nfcwd\nn/Users/x/b\n';
    };
    const listeners = await listListeners(runLsof);
    assert.deepEqual(listeners, [
      { port: 5000, pid: 1129, command: 'ControlCenter', cwd: null },
      { port: 6006, pid: 79986, command: 'node', cwd: '/Users/x/b' },
      { port: 7000, pid: 1129, command: 'ControlCenter', cwd: null },
      { port: 11434, pid: 1519, command: 'ollama', cwd: null },
    ]);
    assert.equal(calls.length, 2);
    const second = calls[1] ?? [];
    assert.equal(second[second.indexOf('-p') + 1], '1129,1519,79986');
    assert.ok(second.includes('cwd'));
  });

  test('returns null when lsof is unavailable', async () => {
    assert.equal(await listListeners(async () => null), null);
  });

  test('no listeners means no second lsof call', async () => {
    let count = 0;
    const listeners = await listListeners(async () => {
      count++;
      return '';
    });
    assert.deepEqual(listeners, []);
    assert.equal(count, 1);
  });

  test('working directories are canonical', async () => {
    const listeners = await listListeners(async (args) =>
      args.includes('cwd') ? 'p42\nfcwd\nn/tmp/../tmp\n' : 'p42\ncnode\nn*:20017\n',
    );
    assert.equal(listeners?.[0]?.cwd?.endsWith('/tmp'), true);
    assert.equal(listeners?.[0]?.cwd?.includes('..'), false);
  });
});
