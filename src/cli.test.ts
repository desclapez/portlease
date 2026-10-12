import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The CLI tests run the compiled binary, so `npm test` builds first.
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

type Run = { code: number; stdout: string; stderr: string };

function run(args: string[], options: { cwd: string; home: string }): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd: options.cwd, env: { ...process.env, PORTLEASE_HOME: options.home } },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'portlease-cli-')));
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(work);
  writeFileSync(join(work, '.ports'), 'WEB_PORT\nAPI_PORT\n');
  return { root, home, work };
}

function workdir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, '.ports'), 'WEB_PORT\nAPI_PORT\n');
  return dir;
}

const CLAIM = ['claim', '--ports', '.ports', '--env', '.env.local'];

function parseEnvLines(text: string): Record<string, number> {
  return Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((line) => {
        const [name, value] = line.split('=');
        return [name, Number(value)];
      }),
  );
}

async function lsJson(home: string, cwd: string): Promise<Array<{ dir: string; name: string; port: number; dirExists: boolean }>> {
  const result = await run(['ls', '--json'], { cwd, home });
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe('portlease claim', () => {
  test('leases every name, writes the env file and prints valid env lines', async () => {
    const { home, work } = sandbox();
    const result = await run(CLAIM, { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`Leased for ${work}:`));
    assert.match(result.stdout, /^WEB_PORT=\d+\nAPI_PORT=\d+\n$/);
    assert.equal(readFileSync(join(work, '.env.local'), 'utf8'), result.stdout);
    const ports = parseEnvLines(result.stdout);
    assert.notEqual(ports.WEB_PORT, ports.API_PORT);
    for (const port of Object.values(ports)) assert.ok(port >= 20000 && port <= 29999, `${port} outside the range`);
  });

  test('is idempotent and restores the ports into a regenerated env file', async () => {
    const { home, work } = sandbox();
    const first = await run(CLAIM, { cwd: work, home });
    writeFileSync(join(work, '.env.local'), 'OTHER=1\nWEB_PORT=4000\n');
    const second = await run(CLAIM, { cwd: work, home });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.stdout, first.stdout);
    const ports = parseEnvLines(first.stdout);
    assert.equal(
      readFileSync(join(work, '.env.local'), 'utf8'),
      `OTHER=1\nWEB_PORT=${ports.WEB_PORT}\nAPI_PORT=${ports.API_PORT}\n`,
    );
  });

  test('overwrites port values copied from another checkout and keeps every other line', async () => {
    const { home, work } = sandbox();
    writeFileSync(join(work, '.env.local'), '# copied from main\nAPI_PORT=4001 # main\nSECRET=x\n');
    const result = await run(CLAIM, { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    const ports = parseEnvLines(result.stdout);
    assert.equal(
      readFileSync(join(work, '.env.local'), 'utf8'),
      `# copied from main\nAPI_PORT=${ports.API_PORT}\nSECRET=x\nWEB_PORT=${ports.WEB_PORT}\n`,
    );
  });

  test('gives another directory different ports', async () => {
    const { root, home, work } = sandbox();
    const other = workdir(root, 'other');
    const a = parseEnvLines((await run(CLAIM, { cwd: work, home })).stdout);
    const b = parseEnvLines((await run(CLAIM, { cwd: other, home })).stdout);
    const all = [...Object.values(a), ...Object.values(b)];
    assert.equal(new Set(all).size, 4);
  });

  test('a directory reached through a symlink gets the same leases', async () => {
    const { root, home, work } = sandbox();
    const link = join(root, 'link');
    symlinkSync(work, link);
    const direct = await run(CLAIM, { cwd: work, home });
    const viaLink = await run([...CLAIM, '--dir', link], { cwd: work, home });
    assert.equal(viaLink.code, 0, viaLink.stderr);
    assert.equal(viaLink.stdout, direct.stdout);
    assert.match(viaLink.stderr, new RegExp(`Leased for ${work}:`));
  });

  test('a dry run through a --dir symlink reports the same leases as the real directory', async () => {
    const { root, home, work } = sandbox();
    const link = join(root, 'link');
    symlinkSync(work, link);
    const claimed = parseEnvLines((await run(CLAIM, { cwd: work, home })).stdout);
    const result = await run([...CLAIM, '--dir', link, '--dry-run'], { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Dry run for ${work}:`));
    assert.match(result.stdout, new RegExp(`WEB_PORT=${claimed.WEB_PORT} {2}existing lease`));
  });

  test('concurrent claims for different directories get disjoint ports', async () => {
    const { root, home } = sandbox();
    const dirs = ['a', 'b', 'c', 'd', 'e'].map((name) => workdir(root, name));
    const results = await Promise.all(dirs.map((cwd) => run(CLAIM, { cwd, home })));
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    const ports = results.flatMap((result) => Object.values(parseEnvLines(result.stdout)));
    assert.equal(ports.length, 10);
    assert.equal(new Set(ports).size, 10);
  });

  test('drops the leases of deleted directories', async () => {
    const { root, home, work } = sandbox();
    const gone = workdir(root, 'gone');
    await run(CLAIM, { cwd: gone, home });
    rmSync(gone, { recursive: true });
    await run(CLAIM, { cwd: work, home });
    const leases = await lsJson(home, work);
    assert.deepEqual([...new Set(leases.map((lease) => lease.dir))], [work]);
  });

  test('missing --ports or --env is a usage error that writes nothing', async () => {
    const { home, work } = sandbox();
    const noEnv = await run(['claim', '--ports', '.ports'], { cwd: work, home });
    assert.equal(noEnv.code, 1);
    assert.match(noEnv.stderr, /missing --env/);
    const noPorts = await run(['claim', '--env', '.env.local'], { cwd: work, home });
    assert.equal(noPorts.code, 1);
    assert.match(noPorts.stderr, /missing --ports/);
    assert.equal(existsSync(join(home, 'leases.json')), false);
    assert.equal(existsSync(join(work, '.env.local')), false);
  });

  test('an invalid ports file is a usage error naming the line', async () => {
    const { home, work } = sandbox();
    writeFileSync(join(work, '.ports'), 'WEB_PORT\nAPI-PORT\n');
    const result = await run(CLAIM, { cwd: work, home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /\.ports:2: "API-PORT"/);
    assert.equal(existsSync(join(home, 'leases.json')), false);
  });

  test('a missing --dir is a usage error', async () => {
    const { root, home, work } = sandbox();
    const result = await run([...CLAIM, '--dir', join(root, 'nope')], { cwd: work, home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not an existing directory/);
  });

  test('an exhausted range fails with code 2 and saves nothing', async () => {
    const { home, work } = sandbox();
    mkdirSync(home);
    writeFileSync(join(home, 'config.json'), '{ "range": { "min": 20000, "max": 20000 } }');
    const result = await run(CLAIM, { cwd: work, home });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /range exhausted/);
    assert.equal(existsSync(join(home, 'leases.json')), false);
    assert.equal(existsSync(join(work, '.env.local')), false);
  });

  test('a registry with a newer format fails with code 3 and stays untouched', async () => {
    const { home, work } = sandbox();
    mkdirSync(home);
    const newer = '{ "version": 2, "cursor": 20000, "leases": [] }';
    writeFileSync(join(home, 'leases.json'), newer);
    const result = await run(CLAIM, { cwd: work, home });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /Upgrade portlease/);
    assert.equal(readFileSync(join(home, 'leases.json'), 'utf8'), newer);
  });

  test('an unwritable env file fails with code 5 and keeps the leases', async () => {
    const { home, work } = sandbox();
    const result = await run(['claim', '--ports', '.ports', '--env', 'missing/.env.local'], { cwd: work, home });
    assert.equal(result.code, 5);
    assert.match(result.stderr, /run claim again/);
    assert.equal((await lsJson(home, work)).length, 2);
  });
});

describe('portlease claim --dry-run', () => {
  test('reports new leases and env changes without writing anything', async () => {
    const { home, work } = sandbox();
    writeFileSync(join(work, '.env.local'), 'API_PORT=4001\n');
    const result = await run([...CLAIM, '--dry-run'], { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Dry run for ${work}: nothing was written\\.`));
    assert.match(result.stdout, /WEB_PORT=\d+ {2}new lease \(tentative\)/);
    assert.match(result.stdout, /~ API_PORT=4001 {2}-> {2}API_PORT=\d+/);
    assert.match(result.stdout, /\+ WEB_PORT=\d+/);
    assert.equal(existsSync(join(home, 'leases.json')), false);
    assert.equal(readFileSync(join(work, '.env.local'), 'utf8'), 'API_PORT=4001\n');
  });

  test('reports existing leases and no changes after a real claim', async () => {
    const { home, work } = sandbox();
    const claimed = await run(CLAIM, { cwd: work, home });
    const ports = parseEnvLines(claimed.stdout);
    const result = await run([...CLAIM, '--dry-run'], { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`WEB_PORT=${ports.WEB_PORT} {2}existing lease`));
    assert.match(result.stdout, /\.env\.local: no changes/);
  });
});

describe('portlease release', () => {
  test('frees the leases of the current directory and succeeds when there is nothing left', async () => {
    const { home, work } = sandbox();
    await run(CLAIM, { cwd: work, home });
    const released = await run(['release'], { cwd: work, home });
    assert.equal(released.code, 0, released.stderr);
    assert.match(released.stderr, new RegExp(`Released 2 port\\(s\\) for ${work}`));
    assert.deepEqual(await lsJson(home, work), []);
    const again = await run(['release'], { cwd: work, home });
    assert.equal(again.code, 0);
    assert.match(again.stderr, /Released 0 port\(s\)/);
  });

  test('frees the leases of a directory that no longer exists', async () => {
    const { root, home, work } = sandbox();
    const gone = workdir(root, 'gone');
    await run(CLAIM, { cwd: gone, home });
    rmSync(gone, { recursive: true });
    const result = await run(['release', '--dir', gone], { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Released 2 port\(s\)/);
  });
});

describe('portlease release from a deleted working directory', () => {
  test('still succeeds, so archive scripts that run after the folder is gone work', async () => {
    const { root, home, work } = sandbox();
    const gone = workdir(root, 'gone');
    await run(CLAIM, { cwd: gone, home });
    const result = await new Promise<Run>((resolve) => {
      execFile(
        'sh',
        ['-c', `cd "$G" && rm -rf "$G" && "$NODE" "$BIN" release`],
        { cwd: work, env: { ...process.env, PORTLEASE_HOME: home, G: gone, NODE: process.execPath, BIN } },
        (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }),
      );
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Released 2 port\(s\)/);
  });
});

describe('portlease release through a dangling symlink', () => {
  test('frees the leases of the directory the link used to point at', async () => {
    const { root, home, work } = sandbox();
    const gone = workdir(root, 'gone');
    const link = join(root, 'link');
    symlinkSync(gone, link);
    await run(CLAIM, { cwd: gone, home });
    rmSync(gone, { recursive: true });
    const result = await run(['release', '--dir', link], { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Released 2 port\(s\)/);
  });
});

describe('portlease ls', () => {
  test('lists leases by directory, marking directories that no longer exist, without cleaning up', async () => {
    const { root, home, work } = sandbox();
    const gone = workdir(root, 'gone');
    const kept = parseEnvLines((await run(CLAIM, { cwd: work, home })).stdout);
    await run(CLAIM, { cwd: gone, home });
    rmSync(gone, { recursive: true });
    const text = await run(['ls'], { cwd: work, home });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`${gone} \\(missing\\)`));
    assert.match(text.stdout, new RegExp(`^${work}\\n {2}WEB_PORT=${kept.WEB_PORT}`, 'm'));
    const json = await lsJson(home, work);
    assert.equal(json.length, 4);
    assert.deepEqual(new Set(json.map((lease) => `${lease.dir}:${lease.dirExists}`)), new Set([`${work}:true`, `${gone}:false`]));
  });

  test('says so when there are no leases', async () => {
    const { home, work } = sandbox();
    const result = await run(['ls'], { cwd: work, home });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'No leases.\n');
  });
});

describe('portlease usage', () => {
  test('an unknown command is a usage error that prints the usage', async () => {
    const { home, work } = sandbox();
    const result = await run(['grab'], { cwd: work, home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown command "grab"/);
    assert.match(result.stderr, /Usage:/);
  });

  test('an unknown option is a usage error', async () => {
    const { home, work } = sandbox();
    const result = await run([...CLAIM, '--force'], { cwd: work, home });
    assert.equal(result.code, 1);
  });

  test('--help prints the usage and succeeds', async () => {
    const { home, work } = sandbox();
    const result = await run(['--help'], { cwd: work, home });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /portlease claim --ports <file> --env <file>/);
  });
});
