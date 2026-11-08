import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExitCode, PortleaseError } from './errors.ts';
import { distinctNames, findManifest, parseManifest } from './manifest.ts';

const usageError = (...patterns: RegExp[]) => (error: unknown) =>
  error instanceof PortleaseError &&
  error.exitCode === ExitCode.usage &&
  patterns.every((pattern) => pattern.test(error.message));

describe('parseManifest', () => {
  test('parses sections in order', () => {
    const content = '[apps/web/.env]\nWEB_PORT\nAPI_PORT\n\n[.env.e2e]\nE2E_WEB_PORT\n';
    assert.deepEqual(parseManifest(content, '.portlease'), [
      { envFile: 'apps/web/.env', names: ['WEB_PORT', 'API_PORT'] },
      { envFile: '.env.e2e', names: ['E2E_WEB_PORT'] },
    ]);
  });

  test('ignores comments, blank lines, CRLF and surrounding spaces', () => {
    const content = '# c\r\n[ .env ]  \r\n  WEB_PORT  \r\n';
    assert.deepEqual(parseManifest(content, '.portlease'), [{ envFile: '.env', names: ['WEB_PORT'] }]);
  });

  test('a name repeated in one section counts once', () => {
    assert.deepEqual(parseManifest('[.env]\nWEB_PORT\nAPI_PORT\nWEB_PORT\n', '.portlease'), [
      { envFile: '.env', names: ['WEB_PORT', 'API_PORT'] },
    ]);
  });

  test('a name before any section is a usage error', () => {
    assert.throws(
      () => parseManifest('WEB_PORT\n[.env]\nAPI_PORT\n', '.portlease'),
      usageError(/^\.portlease:1: "WEB_PORT" is outside a section/),
    );
  });

  test('an invalid name is a usage error naming the line', () => {
    assert.throws(
      () => parseManifest('[.env]\nAPI-PORT\n', '.portlease'),
      usageError(/^\.portlease:2: "API-PORT" is not a valid variable name/),
    );
  });

  test('an empty section is a usage error', () => {
    assert.throws(
      () => parseManifest('[.env]\n[apps/web/.env]\nWEB_PORT\n', '.portlease'),
      usageError(/^\.portlease:1: \[\.env\] has no variable names/),
    );
    assert.throws(
      () => parseManifest('[apps/web/.env]\nWEB_PORT\n[.env]\n', '.portlease'),
      usageError(/^\.portlease:3: \[\.env\] has no variable names/),
    );
  });

  test('the same path twice is a usage error', () => {
    assert.throws(
      () => parseManifest('[.env]\nWEB_PORT\n\n[.env]\nAPI_PORT\n', '.portlease'),
      usageError(/^\.portlease:4: \[\.env\] appears twice/),
    );
  });

  test('a path outside the project is a usage error', () => {
    for (const path of ['/etc/x', '../x/.env', 'apps/../../x', 'apps\\..\\x']) {
      assert.throws(
        () => parseManifest(`[${path}]\nWEB_PORT\n`, '.portlease'),
        usageError(/^\.portlease:1: .*must be a relative path inside the project/),
        path,
      );
    }
  });

  test('a file with no sections is a usage error', () => {
    assert.throws(() => parseManifest('# only a comment\n\n', '.portlease'), usageError(/no sections found/));
  });
});

describe('distinctNames', () => {
  test('keeps first appearance across sections', () => {
    const sections = [
      { envFile: 'a', names: ['API_PORT', 'WEB_PORT'] },
      { envFile: 'b', names: ['PROXY_PORT', 'API_PORT'] },
    ];
    assert.deepEqual(distinctNames(sections), ['API_PORT', 'WEB_PORT', 'PROXY_PORT']);
  });
});

describe('findManifest', () => {
  test('walks up to the nearest .portlease', () => {
    const root = mkdtempSync(join(tmpdir(), 'portlease-manifest-'));
    writeFileSync(join(root, '.portlease'), '[.env]\nWEB_PORT\n');
    const start = join(root, 'apps', 'web');
    mkdirSync(start, { recursive: true });
    const manifest = findManifest(start);
    assert.equal(manifest.dir, realpathSync(root));
    assert.equal(manifest.file, join(realpathSync(root), '.portlease'));
    assert.deepEqual(manifest.sections, [{ envFile: '.env', names: ['WEB_PORT'] }]);
  });

  test('skips a .portlease that is a directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'portlease-manifest-'));
    writeFileSync(join(root, '.portlease'), '[.env]\nWEB_PORT\n');
    const start = join(root, 'apps');
    mkdirSync(join(start, '.portlease'), { recursive: true });
    assert.equal(findManifest(start).dir, realpathSync(root));
  });

  test('without a file anywhere it is a usage error showing an example', () => {
    const start = mkdtempSync(join(tmpdir(), 'portlease-manifest-'));
    assert.throws(() => findManifest(start), usageError(/no \.portlease found/, /\[\.env\]\nWEB_PORT/));
  });

  test('an invalid file is a usage error naming its path', () => {
    const root = mkdtempSync(join(tmpdir(), 'portlease-manifest-'));
    writeFileSync(join(root, '.portlease'), '[.env]\nAPI-PORT\n');
    assert.throws(() => findManifest(root), usageError(/\.portlease:2: "API-PORT"/));
  });
});
