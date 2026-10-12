import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPath, registryHome } from './paths.ts';

describe('registryHome', () => {
  test('PORTLEASE_HOME wins over everything', () => {
    assert.equal(registryHome({ PORTLEASE_HOME: '/tmp/pl', XDG_CONFIG_HOME: '/tmp/xdg' }), '/tmp/pl');
  });

  test('falls back to XDG_CONFIG_HOME/portlease', () => {
    assert.equal(registryHome({ XDG_CONFIG_HOME: '/tmp/xdg' }), '/tmp/xdg/portlease');
  });

  test('falls back to ~/.config/portlease', () => {
    assert.equal(registryHome({}), join(homedir(), '.config', 'portlease'));
  });
});

describe('canonicalPath', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'portlease-paths-'));
    const real = join(root, 'real');
    mkdirSync(real);
    const link = join(root, 'link');
    symlinkSync(real, link);
    return { real: realpathSync(real), link };
  };

  test('resolves an existing directory reached through a symlink to its real path', () => {
    const { real, link } = setup();
    assert.equal(canonicalPath(link), real);
  });

  test('resolves a missing directory through its nearest existing ancestor', () => {
    const { real, link } = setup();
    assert.equal(canonicalPath(join(link, 'gone', 'deeper')), join(real, 'gone', 'deeper'));
  });
});
