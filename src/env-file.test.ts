import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffEnv, readEnvFile, rewriteEnv, writeEnvFile } from './env-file.ts';
import { ExitCode, PortleaseError } from './errors.ts';

const ports = (entries: Record<string, number>) => new Map(Object.entries(entries));
const tempDir = () => mkdtempSync(join(tmpdir(), 'portlease-env-'));

describe('rewriteEnv', () => {
  test('replaces the value in place and keeps every other line byte for byte', () => {
    const content = 'A=1\nAPI_PORT=4001 # main checkout\n# comment\n\nB="two words"\n';
    assert.equal(
      rewriteEnv(content, ports({ API_PORT: 21001 })),
      'A=1\nAPI_PORT=21001\n# comment\n\nB="two words"\n',
    );
  });

  test('keeps the export prefix and normalises spacing around the assignment', () => {
    const content = 'export API_PORT=4001\n  export   WEB_PORT = 4000\n';
    assert.equal(
      rewriteEnv(content, ports({ API_PORT: 21001, WEB_PORT: 21000 })),
      'export API_PORT=21001\nexport WEB_PORT=21000\n',
    );
  });

  test('replaces every duplicate so no stale value survives', () => {
    assert.equal(rewriteEnv('API_PORT=1\nX=2\nAPI_PORT=3\n', ports({ API_PORT: 21001 })), 'API_PORT=21001\nX=2\nAPI_PORT=21001\n');
  });

  test('appends missing names at the end, adding a final newline first when needed', () => {
    assert.equal(rewriteEnv('A=1', ports({ WEB_PORT: 21000, API_PORT: 21001 })), 'A=1\nWEB_PORT=21000\nAPI_PORT=21001\n');
  });

  test('writes only the names into empty content', () => {
    assert.equal(rewriteEnv('', ports({ WEB_PORT: 21000 })), 'WEB_PORT=21000\n');
  });

  test('keeps CRLF line endings on replaced and untouched lines', () => {
    assert.equal(rewriteEnv('A=1\r\nAPI_PORT=4001\r\n', ports({ API_PORT: 21001 })), 'A=1\r\nAPI_PORT=21001\r\n');
  });

  test('appends with CRLF when the file uses CRLF, including the newline added before them', () => {
    assert.equal(rewriteEnv('A=1\r\nB=2', ports({ WEB_PORT: 21000 })), 'A=1\r\nB=2\r\nWEB_PORT=21000\r\n');
  });

  test('leaves look-alike names untouched', () => {
    const content = 'API_PORT_OLD=1\nMY_API_PORT=2\n#API_PORT=3\n';
    assert.equal(rewriteEnv(content, ports({ API_PORT: 21001 })), `${content}API_PORT=21001\n`);
  });
});

describe('diffEnv', () => {
  test('reports replaced and appended lines, omitting lines that already match', () => {
    const content = 'API_PORT=4001\nWEB_PORT=21000\n';
    assert.deepEqual(diffEnv(content, ports({ WEB_PORT: 21000, API_PORT: 21001, STORYBOOK_PORT: 21002 })), [
      { kind: 'replace', name: 'API_PORT', before: 'API_PORT=4001', after: 'API_PORT=21001' },
      { kind: 'append', name: 'STORYBOOK_PORT', after: 'STORYBOOK_PORT=21002' },
    ]);
  });

  test('reports nothing when the file already holds the values', () => {
    assert.deepEqual(diffEnv('WEB_PORT=21000\n', ports({ WEB_PORT: 21000 })), []);
  });
});

describe('readEnvFile', () => {
  test('a missing file reads as empty', () => {
    assert.equal(readEnvFile(join(tempDir(), '.env')), '');
  });
});

describe('writeEnvFile', () => {
  test('creates a missing file with mode 0644', () => {
    const file = join(tempDir(), '.env.local');
    writeEnvFile(file, ports({ WEB_PORT: 21000 }));
    assert.equal(readFileSync(file, 'utf8'), 'WEB_PORT=21000\n');
    assert.equal(statSync(file).mode & 0o777, 0o644);
  });

  test('keeps the permissions of an existing file and leaves no temp file behind', () => {
    const dir = tempDir();
    const file = join(dir, '.env.local');
    writeFileSync(file, 'SECRET=x\n');
    chmodSync(file, 0o600);
    writeEnvFile(file, ports({ WEB_PORT: 21000 }));
    assert.equal(readFileSync(file, 'utf8'), 'SECRET=x\nWEB_PORT=21000\n');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['.env.local']);
  });

  test('writes through a symlink and keeps the link', () => {
    const dir = tempDir();
    const target = join(dir, 'shared.env');
    const link = join(dir, '.env.local');
    writeFileSync(target, 'A=1\n');
    symlinkSync(target, link);
    writeEnvFile(link, ports({ WEB_PORT: 21000 }));
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readFileSync(target, 'utf8'), 'A=1\nWEB_PORT=21000\n');
  });

  test('writes through a dangling symlink, creating its target and keeping the link', () => {
    const dir = tempDir();
    const target = join(dir, 'shared.env');
    const link = join(dir, '.env.local');
    symlinkSync(target, link);
    writeEnvFile(link, ports({ WEB_PORT: 21000 }));
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readFileSync(target, 'utf8'), 'WEB_PORT=21000\n');
  });

  test('a file in a missing directory is an env write error that says how to recover', () => {
    const file = join(tempDir(), 'missing', '.env.local');
    assert.throws(
      () => writeEnvFile(file, ports({ WEB_PORT: 21000 })),
      (error: unknown) =>
        error instanceof PortleaseError && error.exitCode === ExitCode.envWrite && /run claim again/.test(error.message),
    );
  });
});
