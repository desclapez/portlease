# portlease

Unique dev ports per directory, from a machine-wide registry, written into your `.env` files.

Several working copies of a project (git worktrees, one per AI agent) and several projects run dev servers on the same machine. portlease gives each directory its own ports, records them in one registry for the whole machine, and writes them into the project's env files. Your apps keep reading their environment; they never call portlease. When something still collides, `portlease scan` tells you who holds each port.

## Install

Needs Node 22 or newer.

```bash
npm i -g github:desclapez/portlease#v0.2.0
```

npm downloads the repo, compiles it, and installs the result. It takes a few seconds.

Try it without installing:

```bash
npx github:desclapez/portlease#v0.2.0 claim --dry-run
```

**nvm users:** global packages are per Node version. Add `github:desclapez/portlease#v0.2.0` to `$NVM_DIR/default-packages` so every Node version you install gets it, and install it at least on nvm's default version.

## Usage

List the variables your project needs in a `.portlease` file at the project root, committed with the project, grouped by the env file each one is written to:

```
# .portlease
[apps/server/.env]
API_PORT

[apps/web/.env]
WEB_PORT
# the web proxy targets the API: same name, same port
API_PORT
```

Then:

```bash
portlease claim             # lease every name for this project and write each env file
portlease claim --dry-run   # show what would change, write nothing
portlease release           # free this directory's ports
portlease ls                # every lease on the machine (--json for scripts)
portlease scan              # who is listening on each leased port, and what is off
portlease scan 20017        # who holds this one port
```

### `claim`

- Finds `.portlease` in the current directory or the nearest parent, up to the repository root (the first directory with a `.git`), and leases for the directory that holds it. Running `claim` from `apps/web` is the same as running it from the root, and a worktree nested inside another checkout never picks up that checkout's file. `--dir <dir>` starts the search from another directory.
- **The same name in several sections is one lease**, so one port, written to each of those env files. Different names are always different ports.
- **Every env file listed must exist.** If one is missing, `claim` fails before leasing anything and names the file: create it first (for example from its `.env.example`). This keeps a setup script that claims too early from producing an env file that holds only ports.
- Writes each env file with only its section's names. Only those lines change: `NAME=…` and `export NAME=…` lines get the leased value, missing names are appended, and every other line, comment and blank line stays as it is. Values already in the file are always overwritten: the registry is the source of truth.
- Is idempotent: run it again and you get the same ports, written again. Use it to repair an env file you regenerated.
- A name removed from `.portlease` is released on the next `claim` (`Released NAME=port` on stderr). Its line stays in the env file.
- Leases of directories that no longer exist are freed automatically on the next `claim`.
- Prints `NAME=port` lines on stdout, one per distinct name, in the order they first appear in `.portlease`.

### The `.portlease` file

- `[path]` starts a section; the path is the env file, relative to the directory that holds `.portlease`. It must stay inside the project: absolute paths and `..` segments are rejected.
- Below it, one variable name per line (`^[A-Za-z_][A-Za-z0-9_]*$`). Blank lines and `#` comment lines are ignored; a name repeated within a section counts once.
- A name before the first section, an invalid name, an empty section, the same path in two sections, or a file with no sections is an error that names the line.

### `scan`

`scan` crosses the registry with the TCP ports that are listening right now (from `lsof`) and groups the result by leased directory:

```
/work/chargers/feature-a
  WEB_PORT=20017  listening node 81234 (this directory)
  API_PORT=20016  free
  ⚠ 4001          listening node 81240 (this directory), not leased
      → run: portlease claim --dir /work/chargers/feature-a, then restart its servers
/work/chargers/feature-b
  WEB_PORT=20009  ⚠ held by python 7001 (/Users/me/other-project)
Unleased in range
  20500  node 9120 (/Users/me/elsewhere)
```

| Case | Shown as | JSON `status` |
|---|---|---|
| Leased port, nobody listening | `free` | `free` |
| Leased port, listener started from the lease's directory | `listening <cmd> <pid> (this directory)` | `ok` |
| Leased port, listener from anywhere else (another copy, another project, or a process whose directory lsof cannot read: `unknown directory`) | `⚠ held by <cmd> <pid> (<dir>)` | `held-by-other` |
| Leased port busy, but lsof shows no listener (a process of another user or root, such as Docker's proxy on Linux) | `⚠ in use, holder not visible to lsof …` with a `sudo lsof` command to find it | `in-use` |
| A leased directory listening on a port it has not leased (any number): the copy is not using its leases | `⚠ <port> … not leased`, with the `claim` command to run | `not-leased` |
| A listener inside the lease range that belongs to no leased directory | `Unleased in range` group | `unleased-in-range` |

- Listeners outside the range that belong to no leased directory are not shown, so system services (AirPlay, Docker, databases) stay out of the report.
- A listener belongs to a leased directory when its working directory is that directory or inside it (the deepest leased directory wins).
- A port is only reported `free` when a bind probe agrees: lsof cannot see the sockets of processes that belong to another user or root.
- `scan <port>` shows only that port. If nothing leased is involved but something listens on it, it still says who: `5000: ControlCenter 1129 (/), not leased` (JSON `status: "unleased"`), or `in use, not leased` when lsof cannot see the holder. If nothing holds it: `5000: free, not leased`.
- `--json` prints an array of `{ port, lease: { dir, name } | null, listener: { pid, command, cwd } | null, ownerDir, status }`.
- **`scan` never changes anything** and exits 0 whenever it ran, warnings or not. Fixing what it reports is up to you: `claim`, `release`, or stopping a process.
- Without `lsof` on `PATH`, `scan` only says whether each leased port is `in use` or `free`, and prints a note on stderr. `scan` is supported on macOS and Linux, not on Windows.

## With Orca (or any worktree tool)

```yaml
scripts:
  setup: |
    pnpm install                       # create the env files first (copy or generate them)
    portlease claim
  archive: portlease release
```

The main checkout does not need to claim anything; it keeps your apps' default ports.

## Upgrading from 0.1

0.2 replaces the `.ports` files and the `--ports` / `--env` options with one `.portlease` file per project. Put each ports file's names in a section named after its env file, delete the `.ports` files, and replace every `portlease claim --ports … --env …` line with one `portlease claim`. Leases keep their ports as long as the names stay the same.

## Agent skill

`skills/portlease/SKILL.md` teaches a coding agent how to use portlease (commands, the `.portlease` file, env file behavior, `scan` on port collisions, exit codes). To use it with Claude Code, copy the folder into `~/.claude/skills/` (or a project's `.claude/skills/`).

## Renamed or moved directories

Leases are keyed on the directory's path. After renaming or moving a directory, run `portlease claim` again in it: it gets new ports and its env files are rewritten.

## Registry

- Location: `$PORTLEASE_HOME`, else `$XDG_CONFIG_HOME/portlease`, else `~/.config/portlease`.
- `leases.json`: every lease on the machine. Changes are atomic and guarded by `leases.lock`.
- `config.json` (optional): the port range, default `{ "range": { "min": 20000, "max": 29999 } }`. This range sits below the ports the OS hands out for outgoing connections and above the usual hard-coded dev ports.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (for `scan`: it ran, whatever it found) |
| 1 | Usage error (unknown command or option, no `.portlease` found, invalid `.portlease`, a listed env file does not exist, invalid port, `scan` on Windows), or an unexpected error |
| 2 | No free port left in the range |
| 3 | Registry problem (unreadable, invalid, or written by a newer portlease) |
| 4 | The registry stayed locked for more than 10 seconds |
| 5 | An env file could not be written (the ports are leased and the other env files written; run `claim` again) |

## Development

```bash
nvm use            # Node 24
npm install        # also builds dist/
npm test           # builds, then runs node:test on the TypeScript sources
npm run typecheck
npm link           # put your checkout on PATH as `portlease`
```

## License

MIT
