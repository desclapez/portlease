# One manifest per project, and `portlease scan`

Date: 2026-11-08 · Status: draft, waiting for approval

## Why

portlease works, but two things cost time in the one project that uses it today (chargers):

1. **Setup takes one `claim` per env file.** chargers has four `.ports` files and four `claim` lines in `orca.yaml`. That a name shared by two files (`API_PORT` in server and web) gets the same port only works because every claim runs from the same directory; the setup script needs a comment to explain it. The name `.ports` also misleads: the file holds variable names, not ports, and says nothing about which tool reads it.
2. **"Address already in use" means detective work.** Today the user asks the AI, which then cross-checks `lsof` against `portlease ls` by hand. A worse version of the same problem is silent: a working copy whose env file lacks a variable falls back to the app's fixed default port and collides with the main checkout, with no error that points at portlease.

## Goals

- One file per project, `.portlease`, at the project root, lists every leased name grouped by the env file it is written to. `portlease claim` with no options leases and writes all of them.
- `portlease scan` crosses the registry with the ports that are listening right now and reports who holds each one, and flags the cases that mean something is wrong, each with the command that fixes it.
- The agent skill teaches both, and tells the agent to run `scan` first when it sees a port collision.

## Non-goals

- `scan` never changes anything (no automatic re-leasing, no releasing, no env file edits). It reports; `claim` and `release` stay the only commands that change state. Decided with the user.
- No separate `who` command: `portlease scan <port>` covers it with the same output format. Decided with the user.
- No knowledge of git (no releasing leases of merged branches). Orca's archive already releases.
- No hostname routing (`web.branch.localhost`). Different product.
- `claim` does not move a lease whose port was taken by an unrelated program. `scan` reports it; fixing it is a later change.

## Anti-goals

- `claim` must never produce an env file that holds only ports when the project expected a full one (see "Missing env file").
- `scan` must not drown the useful lines in system noise (AirPlay on 5000/7000, Docker, Ollama…).

## Part 1: the manifest

### File

`.portlease`, committed, at the root of the project (the directory that is leased). Replaces the `.ports` files and the `--ports` / `--env` options. Only chargers uses portlease today, so the old form is removed, not kept alongside (decided: fewer cases to test and to explain).

```
# .portlease
[apps/server/.env]
API_PORT

[apps/web/.env]
WEB_PORT
API_PORT
PROXY_PORT
STORYBOOK_PORT

[tools/iberdrola-proxy/.env]
PROXY_PORT

[.env.e2e]
E2E_API_PORT
E2E_WEB_PORT
E2E_IBERDROLA_PORT
E2E_PUSH_RELAY_PORT
```

Rules:

- `[path]` starts a section. The path is the env file, relative to the directory that holds `.portlease`.
- Below it, one variable name per line (`^[A-Za-z_][A-Za-z0-9_]*$`, as today). Blank lines and `#` comment lines are ignored. A name repeated within a section counts once.
- The same name in several sections is one lease, so one port, written to each of those files.
- Errors (exit 1, message names the file and line): a name before the first section, an invalid name, an empty section, the same path in two sections, a path that is absolute or contains a `..` segment, no sections at all. *(Builder's call: the path rule keeps a committed file from writing outside the project; a symlinked env file inside the project still works, as today.)*

### Finding the file and the leased directory

`claim` looks for `.portlease` in the current directory, then in each parent up to the filesystem root, and uses the first one found. The leased directory is the one that holds `.portlease`, so running `claim` from `apps/web` behaves exactly like running it from the root. No `.portlease` found: exit 1 with a message saying so and showing a minimal example.

`--dir <dir>` stays on `claim` and `release` and means "start looking from `<dir>`" for `claim` (the leased directory is still where `.portlease` is found). `release --dir` keeps working for a directory that no longer exists, unchanged.

### `portlease claim [--dir <dir>] [--dry-run]`

1. Read and validate `.portlease`.
2. Check that every env file listed exists. If any is missing, exit 1 before touching the registry, listing every missing file: "`apps/web/.env` does not exist: create it before leasing ports (for example from its `.env.example`)". **Missing env file** is now an error, not a new file. Reason: a setup script that claims before the project creates its env files would otherwise get a file with only ports, and a "copy the example if missing" step then skips it. *(My call, recommended to the user and not yet confirmed: see "Open for the user".)*
3. Under the registry lock: lease every distinct name (existing leases reused, as today) and **release leases of this directory whose name is no longer in `.portlease`**. *(My call: with one file per project, portlease now knows the full set of names for a directory, so a renamed or removed variable frees its port instead of holding it until `release`. Env files are not touched for removed names.)*
4. Write each env file with only its section's names, using today's rewrite rules (replace `NAME=` / `export NAME=` lines, append missing ones, keep everything else byte for byte).
5. Output: `Leased for <dir>:` on stderr, then `NAME=port` lines on stdout, one per distinct name, in the order of first appearance in `.portlease`. If names were released in step 3, add `Released NAME=port` lines on stderr.

`--dry-run` prints, per env file, the lines it would add or change (today's format, one block per file), plus any lease it would release. Nothing is written.

If writing one env file fails, the others are still written, the exit code is 5 and the message names the file. Running `claim` again repairs it (idempotent, as today).

### Unchanged

Registry location and format, allocation (cursor, range, `config.json`), locking, `release`, `ls`, exit codes 2–5.

## Part 2: `portlease scan [port] [--json]`

### What it collects

1. **Leases** from the registry, as `ls` does.
2. **Listeners**: every TCP socket in LISTEN state, with its port, PID and command name, from `lsof -nP -iTCP -sTCP:LISTEN -F pcn`.
3. **Working directory of each listener's PID**, from `lsof -a -p <pids> -d cwd -F pn` (one call for all PIDs). A process can change directory after starting; dev servers do not, so this is a good enough proxy for "launched from". Docker-published ports show Docker's own directory and so are never attributed to a working copy; this is accepted.

A listener **belongs to** a leased directory when its working directory is that directory or inside it (path compared after resolving symlinks, as leases are). If leased directories are nested, the deepest one wins. *(Builder's call.)*

### What it reports

Grouped by leased directory (missing directories marked, as `ls` does), one line per lease:

```
/…/workspaces/chargers/avoid-flash-on-map-navigation
  WEB_PORT=20017   listening  node 81234 (this directory)
  API_PORT=20016   free
  ⚠ 4001           listening  node 81240 (this directory), not leased
      → this copy is not using its leases. Run: portlease claim --dir /…/avoid-flash-on-map-navigation, then restart its servers
/…/workspaces/chargers/api-key-maps
  WEB_PORT=20009   listening  python 7001 (/Users/…/other-project)
      ⚠ held by a process from outside this directory
```

Statuses:

| Case | Shown as | Suggested action |
|---|---|---|
| Leased port, nobody listening | `free` | none |
| Leased port, listener belongs to the lease's directory | `listening <cmd> <pid> (this directory)` | none |
| Leased port, listener from anywhere else (another leased directory, an unrelated directory, or unknown) | `⚠ held by …` with the listener's directory | none automatic: say which process and directory; stopping it or re-leasing is the user's choice |
| A listener belonging to a leased directory, on a port that directory has not leased (any port number, inside or outside the range) | `⚠ <port> … not leased` under that directory | `portlease claim --dir <dir>`, then restart its servers |
| A listener inside the lease range, leased by nobody, not belonging to any leased directory | a final `Unleased in range` group | none (informational: something outside portlease uses the range) |

Listeners outside the range that belong to no leased directory are not shown. That is what keeps system noise out (decided with the user).

**`scan <port>`** shows only lines about that port. If the port is neither leased nor held by a leased directory but something listens on it, it still prints that listener (command, PID, directory) so `scan <port>` always answers "who holds this?". If nothing holds it: `<port>: free, not leased`.

**`--json`**: an array of entries `{ port, lease: { dir, name } | null, listener: { pid, command, cwd } | null, status }`, `status` one of `free`, `ok`, `held-by-other`, `not-leased`, `unleased-in-range`. *(Builder's call on field names.)*

**Exit code** 0 whenever the scan ran, warnings or not. *(My call: scan is a report; a script or agent reads `--json`.)*

### Without lsof, or unsupported platforms

If `lsof` is not on `PATH` or fails, `scan` falls back to probing each leased port with the existing free-port check and prints `in use` / `free` per lease, plus one line on stderr: "lsof not available: showing only whether leased ports are in use, not who holds them". No `not leased` detection in that mode. Supported platforms: macOS and Linux. On Windows `scan` exits 1 with "scan is not supported on Windows". *(My call.)* `lsof` only reports the user's own processes' directories without root; enough for dev machines.

### Implementation notes for the builder

- Keep the `lsof` call behind an injected function (as `isFree` is injected into `leaseNames`) so the classification is unit-tested with fixtures and no real processes. Parse `-F` output, not the column output.
- One `lsof` call for listeners and one for working directories, not one per PID.
- `ls` stays as it is: cheap, no subprocess.

## Part 3: the skill and the README

Update `skills/portlease/SKILL.md` and `README.md` to the manifest and `scan`:

- Replace every `--ports` / `--env` / `.ports` example with `.portlease` and plain `portlease claim`. The "One lease per name, one file per app" section becomes the shared-name rule of the manifest. The worktree setup script example has one `claim` line.
- The audit ("Finding the ports to lease") ends in a proposed `.portlease` instead of ports files. "Which env file holds the ports" still applies per section.
- Missing env file is an error: the setup order rule ("claim after the install and after any env copy") becomes enforced; say so.
- **New: when a port collides.** On "address already in use", a server that came up on an unexpected port, or a test that talks to the wrong server: run `portlease scan <port>` (or `portlease scan`) first, before guessing, and follow the suggested command. Do not kill a process from another working copy without asking the user.
- **New: keeping working copies in sync (drift).** After pulling, rebasing or switching branches in a leased working copy, if `.portlease` changed, run `portlease claim` there and restart its servers. When the agent itself edits `.portlease`, it tells the user that other working copies need `portlease claim` too (`portlease scan` shows which ones are off) and does not run `claim` in other working copies without an ok.
- Update the description's trigger words (`.portlease`, `scan`).
- README: usage, manifest format, `scan`, version.

## Release

Version `0.2.0` (breaking: the `--ports` / `--env` form is gone). Tag `v0.2.0`; install strings in README and skill point to it. Reinstall the global package on each Node version used (nvm).

## Follow-up in chargers (separate PR, after v0.2.0 is installed)

- Add `.portlease` (the example above), delete the four `.ports` files.
- `orca.yaml` setup: one `portlease claim` instead of four (after `pnpm install`, which creates the env files).
- Update `CLAUDE.md` ("Environments": `.ports` files → `.portlease`).
- Existing worktrees keep their ports: leases are keyed on (directory, name) and the names do not change.

## Left to the builder

Module split, error message wording beyond what is quoted, `--json` field names, how the scan output aligns columns, test fixtures.

## Open for the user

- **Missing env file:** refuse (recommended, written above) or create it as today?
