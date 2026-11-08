# Manifest and scan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `--ports`/`--env` with one `.portlease` manifest per project and add `portlease scan`, which reports who holds each leased port and flags working copies that are off their leases.

**Architecture:** A new `manifest.ts` parses and locates `.portlease`; `cli.ts` `claim` drives it (lease all distinct names under one lock, release names that left the manifest, write each env file). `scan` is split into a pure classifier (`scan.ts`) and an `lsof` adapter (`listeners.ts`) injected into it, so classification is unit-tested with fixtures and the CLI tests use real listening sockets.

**Tech Stack:** Node ≥ 22, TypeScript run by type stripping, `node:test`, no runtime dependencies. Commands: `npm run typecheck`, `npm test` (builds `dist/`, then runs `src/**/*.test.ts`; CLI tests run `dist/bin.js`).

**Spec:** `docs/superpowers/specs/2026-11-08-manifest-and-scan-design.md`

## Global Constraints

- No runtime dependencies; only `node:` modules. `lsof` is called as an external program.
- The manifest file is named `.portlease`; section header `[path]`, one name per line, names match `^[A-Za-z_][A-Za-z0-9_]*$`, `#` comments and blank lines ignored.
- The `--ports` / `--env` options and `.ports` files are removed, not deprecated.
- Exit codes unchanged: 0 ok, 1 usage, 2 range exhausted, 3 registry, 4 lock timeout, 5 env write. A missing env file is exit 1, checked before the registry is touched. `scan` exits 0 whenever it ran.
- `scan` never writes the registry or any env file.
- `ls` is unchanged and starts no subprocess.
- Version `0.2.0`; install string `github:desclapez/portlease#v0.2.0`.
- Supported platforms for `scan`: macOS and Linux; on Windows it exits 1 with `scan is not supported on Windows`.

## Review Focus

1. A `.portlease` written on Windows (CRLF) or with trailing spaces after a header or name parses the same as a clean one. → test in Task 1.
2. A name listed in two sections gets one port, written to both env files. → test in Task 3.
3. `claim` run from a subdirectory (`apps/web`) leases the directory that holds `.portlease`, not the subdirectory. → test in Task 3.
4. `lsof` reports one server twice (IPv4 and IPv6 on the same port, same PID); scan shows it once. → test in Task 4.
5. A listener whose working directory is unknown (`lsof` gave none: other user, Docker) on a leased port is reported as held by another process with `unknown directory`, without crashing. → test in Task 5.

---

### Task 1: Manifest parser and locator

**Files:**
- Create: `src/manifest.ts`
- Test: `src/manifest.test.ts`

**Interfaces:**
- Consumes: `NAME_PATTERN` and the error style of `src/ports-file.ts` (move `NAME_PATTERN` into `manifest.ts`; `ports-file.ts` is deleted in Task 3), `PortleaseError`, `ExitCode` from `src/errors.ts`.
- Produces:
  - `export const MANIFEST_FILE = '.portlease'`
  - `export type Section = { envFile: string; names: string[] }` — `envFile` exactly as written in the header (relative path)
  - `export type Manifest = { dir: string; file: string; sections: Section[] }` — `dir` is the directory holding the file, canonical (`canonicalPath`)
  - `export function parseManifest(content: string, label: string): Section[]`
  - `export function findManifest(startDir: string): Manifest` — walks up from `startDir`, reads and parses the first `.portlease` found
  - `export function distinctNames(sections: Section[]): string[]` — first-appearance order

- [ ] **Step 1: Write the failing tests** in `src/manifest.test.ts`:
  - `parses sections in order` — `'[apps/web/.env]\nWEB_PORT\nAPI_PORT\n\n[.env.e2e]\nE2E_WEB_PORT\n'` → `[{ envFile: 'apps/web/.env', names: ['WEB_PORT','API_PORT'] }, { envFile: '.env.e2e', names: ['E2E_WEB_PORT'] }]`
  - `ignores comments, blank lines, CRLF and surrounding spaces` — `'# c\r\n[ .env ]  \r\n  WEB_PORT  \r\n'` → `[{ envFile: '.env', names: ['WEB_PORT'] }]` (header path is trimmed inside the brackets)
  - `a name repeated in one section counts once`
  - `distinctNames keeps first appearance across sections` — sections `[a]: API_PORT, WEB_PORT` and `[b]: PROXY_PORT, API_PORT` → `['API_PORT','WEB_PORT','PROXY_PORT']`
  - Usage errors (`PortleaseError`, `exitCode === ExitCode.usage`), message starting `<label>:<line>:` where a line applies:
    - name before any section → `/:1: "WEB_PORT" is outside a section/`
    - invalid name → `/:2: "API-PORT" is not a valid variable name/`
    - empty section (header followed by another header or EOF) → `/:1: \[\.env\] has no variable names/`
    - same path twice → `/:4: \[\.env\] appears twice/`
    - absolute path `[/etc/x]` and `[../x/.env]` and `[apps/../../x]` → `/must be a relative path inside the project/`
    - no sections at all (only comments) → `/no sections found/`
  - `findManifest walks up to the nearest .portlease` — temp dir `root/.portlease`, start from `root/apps/web` (created) → `dir === realpath(root)`, `file === join(root,'.portlease')`
  - `findManifest without a file anywhere is a usage error showing an example` — start from a fresh temp dir whose ancestors have no `.portlease` (use `mkdtempSync(tmpdir())`) → usage error matching `/no \.portlease found/` and `/\[\.env\]\nWEB_PORT/`

- [ ] **Step 2: Run** `npm run build && node --test src/manifest.test.ts` — Expected: FAIL, cannot find module `./manifest.ts`.

- [ ] **Step 3: Implement** `src/manifest.ts` with the interfaces above. Path rule: reject when `isAbsolute(path)` or any `/`- or `\`-separated segment is `..`. `findManifest` loops `dir = dirname(dir)` until it stops changing; a `.portlease` that is a directory is skipped. Error messages are exactly the regexes above plus a short hint; the not-found message ends with:

  ```
  Create one at the project root, for example:

  [.env]
  WEB_PORT
  ```

- [ ] **Step 4: Run** `npm run build && node --test src/manifest.test.ts` — Expected: PASS. Then `npm run typecheck` — Expected: no errors.

- [ ] **Step 5: Commit**

  ```bash
  git add src/manifest.ts src/manifest.test.ts
  git commit -m "feat: parse and locate the .portlease manifest"
  ```

### Task 2: Release leases whose name left the manifest

**Files:**
- Modify: `src/claim.ts`
- Test: `src/claim.test.ts`

**Interfaces:**
- Consumes: existing `leaseNames` options.
- Produces: `leaseNames(...)` now returns `{ registry: Registry; results: LeaseResult[]; released: Lease[] }`. `released` holds the leases of `dir` whose `name` is not in `names`, in registry order; they are removed from the returned registry. Leases of other directories are untouched. Their ports are not reused within the same call (they stay in `taken` for this allocation, so a just-freed port never moves to another name in one step).

- [ ] **Step 1: Write the failing tests** in `src/claim.test.ts`:
  - `releases leases of the directory whose name is no longer listed` — registry has `/repos/app` `OLD_PORT`=20000 and `WEB_PORT`=20001, and `/repos/other` `OLD_PORT`=20002; `names: ['WEB_PORT']` → `released` is `[{ dir:'/repos/app', name:'OLD_PORT', port:20000, ... }]`, registry keeps `/repos/app WEB_PORT` and `/repos/other OLD_PORT`, `results` is `[{ name:'WEB_PORT', port:20001, reused:true }]`
  - `a freed port is not handed to a new name in the same claim` — registry `/repos/app OLD_PORT=20000`, cursor 20000, `names: ['NEW_PORT']` → `NEW_PORT` gets 20001
  - existing tests: assert `released` is `[]`

- [ ] **Step 2: Run** `npm run build && node --test src/claim.test.ts` — Expected: FAIL on the new tests.

- [ ] **Step 3: Implement** in `src/claim.ts`.

- [ ] **Step 4: Run** `npm run build && node --test src/claim.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/claim.ts src/claim.test.ts
  git commit -m "feat: release leases whose name left the list"
  ```

### Task 3: `claim` reads `.portlease`

**Files:**
- Modify: `src/cli.ts` (`claim`, `formatDryRun`, `USAGE`)
- Modify: `src/cli.test.ts` (claim and dry-run suites, `sandbox`, `workdir`, `CLAIM`)
- Delete: `src/ports-file.ts`, `src/ports-file.test.ts`
- Modify: `.github/workflows/ci.yml` (install smoke test)

**Interfaces:**
- Consumes: `findManifest`, `distinctNames`, `Manifest`, `Section` (Task 1); `leaseNames` with `released` (Task 2); existing `readEnvFile`, `writeEnvFile`, `diffEnv`, `withLock`, `saveRegistry`, `pruneMissingDirs`.
- Produces: CLI `portlease claim [--dir <dir>] [--dry-run]`. `USAGE` becomes:

  ```
  Usage:
    portlease claim [--dir <dir>] [--dry-run]
    portlease release [--dir <dir>]
    portlease ls [--json]
    portlease scan [port] [--json]
  ```

  (`scan` is listed now; Task 6 implements it. Until then `scan` falls to "unknown command".)

- [ ] **Step 1: Rewrite the CLI test helpers and claim tests.** `sandbox()` and `workdir()` write `.portlease` with `'[.env.local]\nWEB_PORT\nAPI_PORT\n'` and create an empty `.env.local`; `CLAIM = ['claim']`. Keep every existing claim, dry-run, release, ls and usage test working with the new helpers. Replace `missing --ports or --env is a usage error…` and `an invalid ports file…` with the new tests below. New tests:
  - `writes each section to its own env file, one port per name across sections` — `.portlease` = `'[apps/server/.env]\nAPI_PORT\n\n[apps/web/.env]\nWEB_PORT\nAPI_PORT\n'`, both env files exist (server one contains `SECRET=1\n`) → server file is `SECRET=1\nAPI_PORT=<a>\n`, web file is `WEB_PORT=<w>\nAPI_PORT=<a>\n`, stdout is `API_PORT=<a>\nWEB_PORT=<w>\n` (first-appearance order)
  - `run from a subdirectory leases the directory that holds .portlease` — run in `work/apps/web` → `ls --json` shows `dir === work` only
  - `a missing env file is a usage error that leases nothing` — `.portlease` lists `.env.local` and `apps/web/.env`, only `.env.local` exists → code 1, stderr matches `/apps\/web\/\.env does not exist: create it before leasing ports/`, `ls --json` is `[]`, `.env.local` unchanged
  - `without a .portlease it is a usage error` — empty work dir → code 1, stderr `/no \.portlease found/`
  - `an invalid .portlease is a usage error naming the line` — `'[.env.local]\nAPI-PORT\n'` → code 1, stderr `/\.portlease:2: "API-PORT"/`
  - `a name removed from .portlease is released on the next claim` — claim, then rewrite `.portlease` without `API_PORT`, claim again → stderr matches `/Released API_PORT=\d+/`, `ls --json` has only `WEB_PORT`, `.env.local` still contains the old `API_PORT=` line
  - `--dir starts the search from another directory` — run from `root` with `--dir work/apps` → leases `work`
  - dry run: `reports changes per env file and leases it would release` — two sections, one name removed after a first claim → stdout contains `Dry run for <work>: nothing was written.`, a block header `apps/web/.env:` with `+ WEB_PORT=` lines, `.env.local: no changes`, and `Would release API_PORT=<port>`; registry and files unchanged

- [ ] **Step 2: Run** `npm test` — Expected: the new claim tests FAIL; others may fail on the helper change until Step 3.

- [ ] **Step 3: Implement `claim` in `src/cli.ts`:** parse `--dir` and `--dry-run` only (strict, so `--ports` is now "unknown option"); `--dir` must be an existing directory (existing error); `findManifest(start)`; resolve each `section.envFile` against `manifest.dir` and collect every one that does not exist (`existsSync`) → one `PortleaseError(..., ExitCode.usage)` listing them, one line each, before any lock. Lease `distinctNames` under the lock; save the registry; write each env file with only its section's names (keep going after a failed write, remember it, then throw the first `ExitCode.envWrite` error naming that file). stderr `Leased for <dir>:` then one `Released NAME=port` line per released lease; stdout `NAME=port` per distinct name. `formatDryRun` takes the per-file diffs (`{ label: string; changes: EnvChange[] }[]`, label = `section.envFile`) and the released leases. Delete `src/ports-file.ts` and its test; update `USAGE`.

- [ ] **Step 4: Update the CI smoke test** in `.github/workflows/ci.yml`: replace the `.ports` line and the claim line with

  ```sh
  printf '[.env.local]\nWEB_PORT\nAPI_PORT\n' > .portlease
  touch .env.local
  portlease claim
  ```

- [ ] **Step 5: Run** `npm run typecheck && npm test` — Expected: all PASS, no reference to `ports-file` left (`grep -rn "ports-file\|--ports" src` prints nothing).

- [ ] **Step 6: Commit**

  ```bash
  git add -A src .github
  git commit -m "feat!: lease every env file of a project from one .portlease"
  ```

### Task 4: Listeners from lsof

**Files:**
- Create: `src/listeners.ts`
- Test: `src/listeners.test.ts`

**Interfaces:**
- Consumes: `canonicalPath` from `src/paths.ts`.
- Produces:
  - `export type Listener = { port: number; pid: number; command: string; cwd: string | null }`
  - `export function parseListening(text: string): Array<{ port: number; pid: number; command: string }>` — parses `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output; deduplicates identical `(port, pid)`; sorted by port then pid
  - `export function parseCwds(text: string): Map<number, string>` — parses `lsof -a -p <pid,pid,...> -d cwd -F pn`
  - `export type RunLsof = (args: string[]) => Promise<string | null>` — `null` when `lsof` cannot be run (ENOENT or non-zero exit with empty stdout)
  - `export async function listListeners(runLsof: RunLsof = defaultRunLsof): Promise<Listener[] | null>` — `null` when the first `lsof` call returns `null`; `cwd` canonicalised with `canonicalPath`, `null` when missing from the second call
  - `defaultRunLsof` uses `execFile('lsof', args)`; note: `lsof` exits 1 when a `-p` PID has gone away, so treat non-zero exit with non-empty stdout as success

- [ ] **Step 1: Write the failing tests** in `src/listeners.test.ts` with fixture strings (fields are one per line, `p` starts a process, `c` its command, `n` a socket or path):
  - `parses ports of every address form` — fixture with `p1129\ncControlCenter\nn*:5000\nn*:7000\np1519\ncollama\nn127.0.0.1:11434\np79986\ncnode\nn[::1]:6006\n` → `[{port:5000,pid:1129,command:'ControlCenter'},{port:6006,pid:79986,command:'node'},{port:7000,pid:1129,...},{port:11434,pid:1519,...}]`
  - `a server on IPv4 and IPv6 is listed once` — `p42\ncnode\nn127.0.0.1:20017\nn[::1]:20017\n` → one entry
  - `parses working directories` — `p79980\nfcwd\nn/Users/x/a\np79986\nfcwd\nn/Users/x/b\n` → `Map { 79980 => '/Users/x/a', 79986 => '/Users/x/b' }`
  - `listListeners joins both calls and leaves unknown directories as null` — fake `runLsof` returns the first fixture for the LISTEN call and a cwd fixture covering only one PID → that PID has its cwd, others `null`; assert the second call's args include `-p` with the comma-joined distinct PIDs
  - `listListeners returns null when lsof is unavailable` — fake returns `null` → `null`
  - `no listeners means no second lsof call` — fake returns `''` → `[]`, called once

- [ ] **Step 2: Run** `npm run build && node --test src/listeners.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/listeners.ts`. Port = digits after the last `:` of an `n` line; skip `n` lines without one.

- [ ] **Step 4: Run** `npm run build && node --test src/listeners.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/listeners.ts src/listeners.test.ts
  git commit -m "feat: read listening ports and their directories from lsof"
  ```

### Task 5: Scan classifier

**Files:**
- Create: `src/scan.ts`
- Test: `src/scan.test.ts`

**Interfaces:**
- Consumes: `Lease` (`src/registry.ts`), `Range` (`src/allocate.ts`), `Listener` (Task 4).
- Produces:
  - `export type ScanStatus = 'free' | 'ok' | 'held-by-other' | 'not-leased' | 'unleased-in-range' | 'unleased' | 'in-use'`
  - `export type ScanEntry = { port: number; lease: { dir: string; name: string } | null; listener: { pid: number; command: string; cwd: string | null } | null; ownerDir: string | null; status: ScanStatus }` — `ownerDir` is the leased directory the listener belongs to (set for `ok` and `not-leased`, else `null`)
  - `export function classify(options: { leases: Lease[]; listeners: Listener[]; range: Range; port?: number }): ScanEntry[]`
  - `export function owner(cwd: string | null, dirs: string[]): string | null` — the deepest `dir` such that `cwd === dir` or `cwd` starts with `dir + sep`

  Rules (spec, Part 2): one entry per lease (`free` / `ok` / `held-by-other`, using the listener on that port; several listeners on one leased port → one entry per listener). Then one `not-leased` entry per listener whose owner is a leased directory and whose port that directory has not leased (any port). Then one `unleased-in-range` entry per listener inside `range`, on a port nobody leased, with no owner. With `port`, only entries for that port; if none and a listener holds it, one `unleased` entry for it; if none and nothing holds it, `[]`. `in-use` is used only by the CLI fallback (Task 6), never by `classify`. Order: leases sorted by `dir` then `port`, then `not-leased` by dir then port, then `unleased-in-range` by port.

- [ ] **Step 1: Write the failing tests** in `src/scan.test.ts` (range 20000–29999, dirs `/w/a` and `/w/b`):
  - `a leased port nobody listens on is free`
  - `a leased port held from its own directory or a subdirectory is ok` — listener cwd `/w/a/apps/web` on `/w/a`'s port → `ok`
  - `a leased port held from elsewhere is held-by-other` — cwd `/w/b` → `held-by-other`, listener cwd kept
  - `a listener with an unknown directory on a leased port is held-by-other` — cwd `null` → `held-by-other`, `listener.cwd === null` (Review Focus 5)
  - `a copy listening on a port it has not leased is not-leased, whatever the number` — cwd `/w/a`, port 4001 → `{ port:4001, lease:null, ownerDir:'/w/a', status:'not-leased' }`; also port 20500 unleased from `/w/a` → `not-leased`
  - `noise outside the range is ignored` — cwd `/`, port 5000 → no entry
  - `an unknown listener inside the range is unleased-in-range` — cwd `/`, port 20500 → `unleased-in-range`
  - `nested leased directories: the deepest owns` — dirs `/w/a`, `/w/a/sub`; `owner('/w/a/sub/x', ...) === '/w/a/sub'`; `owner('/w/ab', ['/w/a']) === null`
  - `filtered by port: only that port; an unrelated holder is unleased` — `port: 5000` with cwd `/` listener → `[{ port:5000, lease:null, status:'unleased', listener:{...} }]`; `port: 5001` nothing → `[]`
- [ ] **Step 2: Run** `npm run build && node --test src/scan.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/scan.ts`.

- [ ] **Step 4: Run** `npm run build && node --test src/scan.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/scan.ts src/scan.test.ts
  git commit -m "feat: classify leases against listening ports"
  ```

### Task 6: `portlease scan` command

**Files:**
- Modify: `src/cli.ts` (add `scan`; extend `Io` with `platform: NodeJS.Platform` and `listListeners: () => Promise<Listener[] | null>`)
- Modify: `src/bin.ts` (pass `process.platform` and the real `listListeners`)
- Test: `src/cli.test.ts` (new `portlease scan` suite)

**Interfaces:**
- Consumes: `classify`, `ScanEntry` (Task 5); `listListeners` (Task 4); `isPortFree` (`src/free-port.ts`); `readRegistry`, `readConfig`, `registryHome`.
- Produces: `portlease scan [port] [--json]`.

  Text output (columns may be padded; tests match with `\s+`):

  ```
  <dir>[ (missing)]
    NAME=PORT  free
    NAME=PORT  listening <command> <pid> (this directory)
    NAME=PORT  ⚠ held by <command> <pid> (<cwd>|unknown directory)
    ⚠ PORT  listening <command> <pid> (this directory), not leased
        → run: portlease claim --dir <dir>, then restart its servers
  Unleased in range
    PORT  <command> <pid> (<cwd>|unknown directory)
  ```

  `scan <port>` with an `unleased` entry: `<port>: <command> <pid> (<cwd>|unknown directory), not leased`. With no entries: `<port>: free, not leased`. No leases and no flagged listeners: `No leases.` `--json`: `JSON.stringify(entries, null, 2)` (all fields of `ScanEntry`).

  Fallback when `listListeners()` returns `null`: stderr `lsof not available: showing only whether leased ports are in use, not who holds them`; each lease probed with `isPortFree` → line `NAME=PORT  in use` or `NAME=PORT  free` (JSON status `in-use` / `free`, `listener: null`). On `io.platform === 'win32'`: usage error `scan is not supported on Windows`. A `port` argument that is not an integer 1–65535: usage error `"<arg>" is not a port`.

- [ ] **Step 1: Write the failing tests** in `src/cli.test.ts`, `describe('portlease scan')`. Use a helper that starts a real listener as a child process: `spawn(process.execPath, ['-e', 'require("net").createServer().listen(Number(process.argv[1]), "127.0.0.1", () => console.log("up"))', String(port)], { cwd })`, wait for `up`, and kill it in `t.after`. Tests:
  - `marks a leased port held from its own directory` — claim in `work`, start a listener on its `WEB_PORT` with `cwd: work` → stdout matches `/WEB_PORT=\d+\s+listening node \d+ \(this directory\)/` and `/API_PORT=\d+\s+free/`
  - `flags a copy listening on a port it has not leased` — listener on a free port outside the range (pick with `listen(0)` first, then close and reuse the number) with `cwd: work` → stdout matches `/⚠ \d+\s+listening node \d+ \(this directory\), not leased/` and `→ run: portlease claim --dir ${work}`
  - `scan <port> answers who holds an unleased port` — listener on a free port with `cwd: root` (no leases there), `scan <that port>` → stdout matches `/^\d+: node \d+ \(.*\), not leased$/m`
  - `scan <port> on a free port` → stdout `<port>: free, not leased\n`
  - `--json lists entries with their status` — claim, no listeners → JSON array whose entries have `status: 'free'` and `lease.name` in `['WEB_PORT','API_PORT']`
  - `without lsof it only says whether leased ports are in use` — run with `env.PATH = dirname(process.execPath)` (extend `run` with an optional `env` override) → stderr matches `/lsof not available/`, stdout matches `/WEB_PORT=\d+\s+(in use|free)/`, code 0
  - `an invalid port is a usage error` — `scan abc` → code 1, stderr `/"abc" is not a port/`
  - `scan never writes` — compare `leases.json` and `.env.local` bytes before/after a scan with a `not-leased` warning
  - Windows guard: unit test calling `main(['scan'], io)` directly with a fake `Io` where `platform: 'win32'` → returns 1, stderr `/not supported on Windows/`

- [ ] **Step 2: Run** `npm test` — Expected: the scan tests FAIL (unknown command).

- [ ] **Step 3: Implement** `scan` in `src/cli.ts` and wire `bin.ts`. CI runs on `ubuntu-latest` and `macos-latest`; both ship `lsof`. If a CI run shows `lsof` missing on Ubuntu, add `sudo apt-get install -y lsof` to the workflow rather than skipping tests.

- [ ] **Step 4: Run** `npm run typecheck && npm test` — Expected: all PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src .github
  git commit -m "feat: add portlease scan to see who holds each port"
  ```

### Task 7: README, skill, version

**Files:**
- Modify: `README.md`, `skills/portlease/SKILL.md`, `package.json` (`"version": "0.2.0"`), `package-lock.json` (run `npm install --package-lock-only`)

**Interfaces:**
- Consumes: final CLI behaviour from Tasks 3 and 6.

- [ ] **Step 1: README.** Install strings → `#v0.2.0`. Usage section shows the `.portlease` example (two sections, a shared name), `portlease claim`, `--dry-run`, `release`, `ls`, `scan`, `scan <port>`, `--json`. Document: env files must exist; names removed from `.portlease` are released on the next claim; the shared-name rule; `scan` statuses table and that it never changes anything; `lsof` fallback; Windows unsupported for `scan`. Orca example: one `portlease claim`. Add a short "Upgrading from 0.1" note: replace `.ports` files and `--ports/--env` lines with one `.portlease`; leases keep their ports when names stay the same.

- [ ] **Step 2: Skill** (`skills/portlease/SKILL.md`), per spec Part 3: description mentions `.portlease` and `portlease scan`; commands section; "The ports file" → "The .portlease file"; "One lease per name, one file per app" → shared-name rule within one file; audit ends in a proposed `.portlease`; setup script example has one `claim` after the env files exist, and says a missing env file now fails; Verify block uses `portlease claim --dry-run` / `portlease claim`; new section **When a port collides** (run `portlease scan <port>` or `portlease scan` first, follow its suggested command, never kill another working copy's process without asking); new section **Keeping working copies in sync** (after pull/rebase/branch switch, if `.portlease` changed, run `portlease claim` there and restart servers; when the agent edits `.portlease`, tell the user other working copies need `claim` — `scan` shows which — and do not claim in other working copies without an ok); exit code 1 row mentions a missing `.portlease`, invalid `.portlease` and missing env file; install strings `#v0.2.0`.

- [ ] **Step 3: Version.** `package.json` version `0.2.0`; `npm install --package-lock-only`.

- [ ] **Step 4: Verify** — `grep -rn "\-\-ports\|\.ports\b\|v0\.1\.0" README.md skills src .github` prints only the "Upgrading from 0.1" note; `npm run typecheck && npm test` PASS; `npm pack --dry-run` lists `dist/` only.

- [ ] **Step 5: Commit**

  ```bash
  git add README.md skills package.json package-lock.json
  git commit -m "docs: document .portlease and portlease scan, release 0.2.0"
  ```

### Task 8: Finish

- [ ] **Step 1:** Whole-branch review (superpowers:requesting-code-review), fix findings.
- [ ] **Step 2:** `npm run typecheck && npm test` — all PASS.
- [ ] **Step 3:** Ask the user before pushing and opening the PR. After the merge, the `v0.2.0` tag and the chargers follow-up (spec, "Follow-up in chargers") are separate steps the user starts.

Only after the user says the PR is merged:

- [ ] **Step 4: Tag the release.** `git fetch`; check that `origin/main` contains the merge and that its `package.json` says `0.2.0`. Create the annotated tag `v0.2.0` on that `origin/main` commit. Ask the user before `git push origin v0.2.0`.
- [ ] **Step 5: Install it on this machine.** `npm i -g github:desclapez/portlease#v0.2.0` on nvm's default Node version, and on the `.nvmrc` version if it differs. Check that `portlease --help` shows `portlease claim [--dir <dir>] [--dry-run]` and `portlease scan`. If `$NVM_DIR/default-packages` has the `#v0.1.0` entry, propose changing it to `#v0.2.0` (do not change it without an ok). Then tell the user chargers can be adapted; that adaptation is done separately, in a chargers worktree, not here.
