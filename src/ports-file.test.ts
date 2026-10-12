import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExitCode, PortleaseError } from './errors.ts';
import { parsePorts, readPortsFile } from './ports-file.ts';

const usageError = (pattern: RegExp) => (error: unknown) =>
  error instanceof PortleaseError && error.exitCode === ExitCode.usage && pattern.test(error.message);

describe('parsePorts', () => {
  test('returns names in file order, skipping comments, blank lines and surrounding whitespace', () => {
    const content = '# ports for this project\nWEB_PORT\n\n  API_PORT  \r\n   \n';
    assert.deepEqual(parsePorts(content, '.ports'), ['WEB_PORT', 'API_PORT']);
  });

  test('counts a repeated name once', () => {
    assert.deepEqual(parsePorts('WEB_PORT\nAPI_PORT\nWEB_PORT\n', '.ports'), ['WEB_PORT', 'API_PORT']);
  });

  test('rejects an invalid name, naming the file and the line', () => {
    assert.throws(() => parsePorts('WEB_PORT\n\nAPI-PORT\n', '.ports'), usageError(/^\.ports:3: "API-PORT"/));
  });

  test('rejects a name starting with a digit', () => {
    assert.throws(() => parsePorts('1PORT\n', '.ports'), usageError(/^\.ports:1: "1PORT"/));
  });

  test('rejects a file with no names', () => {
    assert.throws(() => parsePorts('# only a comment\n\n', '.ports'), usageError(/no variable names/));
  });
});

describe('readPortsFile', () => {
  test('reads and parses the file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'portlease-ports-')), '.ports');
    writeFileSync(file, 'WEB_PORT\n');
    assert.deepEqual(readPortsFile(file), ['WEB_PORT']);
  });

  test('a missing file is a usage error naming the path', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'portlease-ports-')), 'missing.ports');
    assert.throws(() => readPortsFile(file), usageError(/cannot read ports file .*missing\.ports/));
  });
});
