# portlease

Unique dev ports per directory, from a machine-wide registry, written into your `.env`.

Several working copies of a project (git worktrees, one per AI agent) and several projects run dev servers on the same machine. portlease gives each directory its own ports, records them in one registry for the whole machine, and writes them into an env file. Your apps keep reading their environment; they never call portlease.

## Install

Needs Node 22 or newer.

```bash
npm i -g github:desclapez/portlease#v0.1.0
```

npm downloads the repo, compiles it, and installs the result. It takes a few seconds.

Try it without installing:

```bash
npx github:desclapez/portlease#v0.1.0 claim --ports .ports --env .env.local --dry-run
```

**nvm users:** global packages are per Node version. Add `github:desclapez/portlease#v0.1.0` to `$NVM_DIR/default-packages` so every Node version you install gets it, and install it at least on nvm's default version.

## Usage

Declare the variables your project needs, one per line, in a file committed with the project:

```
# .ports
WEB_PORT
API_PORT
```

Then:

```bash
portlease claim --ports .ports --env .env.local   # lease ports for this directory and write them to .env.local
portlease claim --ports .ports --env .env.local --dry-run   # show what would happen, change nothing
portlease release                                 # free this directory's ports
portlease ls                                      # every lease on the machine (--json for scripts)
```

- `claim` is idempotent: run it again and you get the same ports, written again into the env file. Use it to repair an env file you regenerated.
- `claim` only touches the listed variables. Other lines, comments and blank lines stay as they are. Values already in the env file are always overwritten: the registry is the source of truth.
- Both `--ports` and `--env` are required. `--dir <dir>` leases for another directory instead of the current one.
- Leases of directories that no longer exist are freed automatically on the next `claim`.

## With Orca (or any worktree tool)

```yaml
scripts:
  setup: |
    cp ../app/.env.local .env.local    # copy or generate the env file first
    portlease claim --ports .ports --env .env.local
  archive: portlease release
```

The main checkout does not need to claim anything; it keeps your apps' default ports.

## Renamed or moved directories

Leases are keyed on the directory's path. After renaming or moving a directory, run `portlease claim` again in it: it gets new ports and its env file is rewritten.

## Registry

- Location: `$PORTLEASE_HOME`, else `$XDG_CONFIG_HOME/portlease`, else `~/.config/portlease`.
- `leases.json`: every lease on the machine. Changes are atomic and guarded by `leases.lock`.
- `config.json` (optional): the port range, default `{ "range": { "min": 20000, "max": 29999 } }`. This range sits below the ports the OS hands out for outgoing connections and above the usual hard-coded dev ports.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Usage error (unknown command or option, missing `--ports` / `--env`, invalid ports file), or an unexpected error |
| 2 | No free port left in the range |
| 3 | Registry problem (unreadable, invalid, or written by a newer portlease) |
| 4 | The registry stayed locked for more than 10 seconds |
| 5 | The env file could not be written (the ports are leased; run `claim` again) |

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
