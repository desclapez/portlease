import { describe, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, type Io } from './cli.ts';

// The CLI tests run the compiled binary, so `npm test` builds first.
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

type Run = { code: number; stdout: string; stderr: string };

function run(args: string[], options: { cwd: string; home: string; env?: NodeJS.ProcessEnv }): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, ...args],
      { cwd: options.cwd, env: { ...process.env, PORTLEASE_HOME: options.home, ...options.env } },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

const MANIFEST = '[.env.local]\nWEB_PORT\nAPI_PORT\n';

function workdir(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, '.portlease'), MANIFEST);
  writeFileSync(join(dir, '.env.local'), '');
  return dir;
}

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'portlease-cli-')));
  const home = join(root, 'home');
  const work = workdir(root, 'work');
  return { root, home, work };
}

// Creates each env file (empty unless given content) under dir.
function envFiles(dir: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), content);
  }
}

const CLAIM = ['claim'];

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

  test('writes each section to its own env file, one port per name across sections', async () => {
    const { home, work } = sandbox();
    writeFileSync(join(work, '.portlease'), '[apps/server/.env]\nAPI_PORT\n\n[apps/web/.env]\nWEB_PORT\nAPI_PORT\n');
    envFiles(work, { 'apps/server/.env': 'SECRET=1\n', 'apps/web/.env': '' });
    const result = await run(CLAIM, { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^API_PORT=\d+\nWEB_PORT=\d+\n$/);
    const ports = parseEnvLines(result.stdout);
    assert.notEqual(ports.API_PORT, ports.WEB_PORT);
    assert.equal(readFileSync(join(work, 'apps/server/.env'), 'utf8'), `SECRET=1\nAPI_PORT=${ports.API_PORT}\n`);
    assert.equal(readFileSync(join(work, 'apps/web/.env'), 'utf8'), `WEB_PORT=${ports.WEB_PORT}\nAPI_PORT=${ports.API_PORT}\n`);
    assert.equal(readFileSync(join(work, '.env.local'), 'utf8'), '');
    assert.equal((await lsJson(home, work)).length, 2);
  });

  test('run from a subdirectory leases the directory that holds .portlease', async () => {
    const { home, work } = sandbox();
    const web = join(work, 'apps', 'web');
    mkdirSync(web, { recursive: true });
    const result = await run(CLAIM, { cwd: web, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`Leased for ${work}:`));
    assert.deepEqual([...new Set((await lsJson(home, work)).map((lease) => lease.dir))], [work]);
    assert.equal(readFileSync(join(work, '.env.local'), 'utf8'), result.stdout);
  });

  test('--dir starts the search from another directory', async () => {
    const { root, home, work } = sandbox();
    mkdirSync(join(work, 'apps'));
    const result = await run([...CLAIM, '--dir', join(work, 'apps')], { cwd: root, home });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual([...new Set((await lsJson(home, work)).map((lease) => lease.dir))], [work]);
  });

  test('a missing env file is a usage error that leases nothing', async () => {
    const { home, work } = sandbox();
    writeFileSync(join(work, '.env.local'), 'SECRET=1\n');
    writeFileSync(join(work, '.portlease'), '[.env.local]\nWEB_PORT\n\n[apps/web/.env]\nWEB_PORT\n\n[apps/server/.env]\nAPI_PORT\n');
    const result = await run(CLAIM, { cwd: work, home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /apps\/web\/\.env does not exist: create it before leasing ports/);
    assert.match(result.stderr, /apps\/server\/\.env does not exist/);
    assert.deepEqual(await lsJson(home, work), []);
    assert.equal(readFileSync(join(work, '.env.local'), 'utf8'), 'SECRET=1\n');
  });

  test('without a .portlease it is a usage error', async () => {
    const { root, home } = sandbox();
    const empty = join(root, 'empty');
    mkdirSync(empty);
    const result = await run(CLAIM, { cwd: empty, home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no \.portlease found/);
  });

  test('an invalid .portlease is a usage error naming the line', async () => {
    const { home, work } = sandbox();
    writeFileSync(join(work, '.portlease'), '[.env.local]\nAPI-PORT\n');
    const result = await run(CLAIM, { cwd: work, home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /\.portlease:2: "API-PORT"/);
    assert.equal(existsSync(join(home, 'leases.json')), false);
  });

  test('a name removed from .portlease is released on the next claim', async () => {
    const { home, work } = sandbox();
    const first = parseEnvLines((await run(CLAIM, { cwd: work, home })).stdout);
    writeFileSync(join(work, '.portlease'), '[.env.local]\nWEB_PORT\n');
    const second = await run(CLAIM, { cwd: work, home });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stderr, new RegExp(`Released API_PORT=${first.API_PORT}`));
    assert.equal(second.stdout, `WEB_PORT=${first.WEB_PORT}\n`);
    assert.deepEqual((await lsJson(home, work)).map((lease) => lease.name), ['WEB_PORT']);
    assert.match(readFileSync(join(work, '.env.local'), 'utf8'), new RegExp(`^API_PORT=${first.API_PORT}$`, 'm'));
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
    assert.equal(readFileSync(join(work, '.env.local'), 'utf8'), '');
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

  test('an unwritable env file fails with code 5, names it, and still writes the others', async (t) => {
    const { home, work } = sandbox();
    writeFileSync(join(work, '.portlease'), '[locked/.env]\nWEB_PORT\n\n[.env.local]\nWEB_PORT\nAPI_PORT\n');
    envFiles(work, { 'locked/.env': '' });
    chmodSync(join(work, 'locked'), 0o555);
    t.after(() => chmodSync(join(work, 'locked'), 0o755));
    const result = await run(CLAIM, { cwd: work, home });
    assert.equal(result.code, 5);
    assert.match(result.stderr, /cannot write env file .*locked\/\.env.*run claim again/);
    assert.equal((await lsJson(home, work)).length, 2);
    assert.match(readFileSync(join(work, '.env.local'), 'utf8'), /^WEB_PORT=\d+\nAPI_PORT=\d+\n$/);
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

  test('reports changes per env file and leases it would release', async () => {
    const { home, work } = sandbox();
    const claimed = parseEnvLines((await run(CLAIM, { cwd: work, home })).stdout);
    writeFileSync(join(work, '.portlease'), '[.env.local]\nWEB_PORT\n\n[apps/web/.env]\nWEB_PORT\n');
    envFiles(work, { 'apps/web/.env': '' });
    const leasesBefore = readFileSync(join(home, 'leases.json'), 'utf8');
    const envBefore = readFileSync(join(work, '.env.local'), 'utf8');
    const result = await run([...CLAIM, '--dry-run'], { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Dry run for ${work}: nothing was written\\.`));
    assert.match(result.stdout, new RegExp(`^apps/web/\\.env:\\n {2}\\+ WEB_PORT=${claimed.WEB_PORT}$`, 'm'));
    assert.match(result.stdout, /^\.env\.local: no changes$/m);
    assert.match(result.stdout, new RegExp(`Would release API_PORT=${claimed.API_PORT}`));
    assert.equal(readFileSync(join(home, 'leases.json'), 'utf8'), leasesBefore);
    assert.equal(readFileSync(join(work, '.env.local'), 'utf8'), envBefore);
    assert.equal(readFileSync(join(work, 'apps/web/.env'), 'utf8'), '');
  });

  test('a missing env file fails the dry run too', async () => {
    const { home, work } = sandbox();
    writeFileSync(join(work, '.portlease'), '[apps/web/.env]\nWEB_PORT\n');
    const result = await run([...CLAIM, '--dry-run'], { cwd: work, home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /apps\/web\/\.env does not exist/);
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

  test('the removed --ports and --env options are unknown', async () => {
    const { home, work } = sandbox();
    const result = await run(['claim', '--ports', '.ports', '--env', '.env.local'], { cwd: work, home });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--ports/);
    assert.equal(existsSync(join(home, 'leases.json')), false);
  });

  test('--help prints the usage and succeeds', async () => {
    const { home, work } = sandbox();
    const result = await run(['--help'], { cwd: work, home });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /portlease claim \[--dir <dir>\] \[--dry-run\]/);
    assert.match(result.stdout, /portlease scan \[port\] \[--json\]/);
  });
});

// A real server, started from `cwd`, so lsof reports it with that working directory.
async function listen(t: TestContext, port: number, cwd: string): Promise<number> {
  const script = 'require("net").createServer().listen(Number(process.argv[1]), "127.0.0.1", () => console.log("up"))';
  const child = spawn(process.execPath, ['-e', script, String(port)], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => {
    child.kill();
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('exit', (code) => reject(new Error(`listener on ${port} exited with ${code}`)));
  });
  return child.pid as number;
}

// A port nobody holds right now, outside the lease range (the OS picks from its ephemeral range).
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

describe('portlease scan', () => {
  test('marks a leased port held from its own directory', async (t) => {
    const { home, work } = sandbox();
    const ports = parseEnvLines((await run(CLAIM, { cwd: work, home })).stdout);
    const pid = await listen(t, ports.WEB_PORT as number, work);
    const result = await run(['scan'], { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^${work}$`, 'm'));
    assert.match(result.stdout, new RegExp(`WEB_PORT=${ports.WEB_PORT}\\s+listening node ${pid} \\(this directory\\)`));
    assert.match(result.stdout, new RegExp(`API_PORT=${ports.API_PORT}\\s+free`));
  });

  test('flags a copy listening on a port it has not leased', async (t) => {
    const { home, work } = sandbox();
    await run(CLAIM, { cwd: work, home });
    const port = await freePort();
    const pid = await listen(t, port, join(work));
    const result = await run(['scan'], { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`⚠ ${port}\\s+listening node ${pid} \\(this directory\\), not leased`));
    assert.ok(result.stdout.includes(`→ run: portlease claim --dir ${work}, then restart its servers`), result.stdout);
  });

  test('flags a leased port held by a process from elsewhere', async (t) => {
    const { root, home, work } = sandbox();
    const ports = parseEnvLines((await run(CLAIM, { cwd: work, home })).stdout);
    const pid = await listen(t, ports.API_PORT as number, root);
    const result = await run(['scan'], { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`API_PORT=${ports.API_PORT}\\s+⚠ held by node ${pid} \\(${root}\\)`));
  });

  test('scan <port> answers who holds an unleased port', async (t) => {
    const { root, home } = sandbox();
    const port = await freePort();
    const pid = await listen(t, port, root);
    const result = await run(['scan', String(port)], { cwd: root, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^${port}: node ${pid} \\(${root}\\), not leased$`, 'm'));
  });

  test('scan <port> on a free port', async () => {
    const { home, work } = sandbox();
    const port = await freePort();
    const result = await run(['scan', String(port)], { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, `${port}: free, not leased\n`);
  });

  test('scan <port> on a leased port shows only that lease', async () => {
    const { home, work } = sandbox();
    const ports = parseEnvLines((await run(CLAIM, { cwd: work, home })).stdout);
    const result = await run(['scan', String(ports.WEB_PORT)], { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`WEB_PORT=${ports.WEB_PORT}\\s+free`));
    assert.doesNotMatch(result.stdout, /API_PORT/);
  });

  test('--json lists entries with their status', async () => {
    const { home, work } = sandbox();
    await run(CLAIM, { cwd: work, home });
    const result = await run(['scan', '--json'], { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    const entries = JSON.parse(result.stdout) as Array<{ status: string; lease: { dir: string; name: string } | null }>;
    const ours = entries.filter((entry) => entry.lease?.dir === work);
    assert.deepEqual(ours.map((entry) => entry.lease?.name).sort(), ['API_PORT', 'WEB_PORT']);
    for (const entry of ours) assert.equal(entry.status, 'free');
  });

  test('says so when there are no leases', async () => {
    const { home, work } = sandbox();
    const result = await run(['scan'], { cwd: work, home });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^No leases\.$/m);
  });

  test('without lsof it only says whether leased ports are in use', async () => {
    const { home, work } = sandbox();
    await run(CLAIM, { cwd: work, home });
    const result = await run(['scan'], { cwd: work, home, env: { PATH: dirname(process.execPath) } });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /lsof not available: showing only whether leased ports are in use, not who holds them/);
    assert.match(result.stdout, /WEB_PORT=\d+\s+(in use|free)/);
    assert.match(result.stdout, /API_PORT=\d+\s+(in use|free)/);
  });

  test('an invalid port is a usage error', async () => {
    const { home, work } = sandbox();
    for (const arg of ['abc', '0', '65536', '80.5']) {
      const result = await run(['scan', arg], { cwd: work, home });
      assert.equal(result.code, 1, arg);
      assert.match(result.stderr, new RegExp(`"${arg.replace('.', '\\.')}" is not a port`));
    }
  });

  test('scan never writes', async (t) => {
    const { home, work } = sandbox();
    await run(CLAIM, { cwd: work, home });
    await listen(t, await freePort(), work);
    const leasesBefore = readFileSync(join(home, 'leases.json'), 'utf8');
    const envBefore = readFileSync(join(work, '.env.local'), 'utf8');
    const result = await run(['scan'], { cwd: work, home });
    assert.match(result.stdout, /not leased/);
    assert.equal(readFileSync(join(home, 'leases.json'), 'utf8'), leasesBefore);
    assert.equal(readFileSync(join(work, '.env.local'), 'utf8'), envBefore);
  });

  test('is not supported on Windows', async () => {
    const { home, work } = sandbox();
    let stderr = '';
    const io: Io = {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      cwd: work,
      env: { PORTLEASE_HOME: home },
      platform: 'win32',
      listListeners: async () => [],
    };
    assert.equal(await main(['scan'], io), 1);
    assert.match(stderr, /scan is not supported on Windows/);
  });
});
