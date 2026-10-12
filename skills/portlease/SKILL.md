---
name: portlease
description: Lease unique dev ports per directory (git worktree, checkout, project) from a machine-wide registry and write them into .env files with the `portlease` CLI. Use whenever the user mentions port collisions between worktrees or projects, a `.ports` file, `portlease`, giving each worktree or agent its own ports, Orca setup/archive scripts that need ports, or ports in a `.env` that must not clash — even if they do not name the tool.
---

# portlease

`portlease` hands out one unique port per (directory, variable name) from a registry shared by the whole machine, and writes the ports into an env file. Several worktrees of one project, or several projects, can then run dev servers at the same time without colliding. Applications never call it: they only read their environment.

Use it from whatever creates and destroys a working copy (Orca `setup` / `archive` scripts, a shell script, by hand).

## Commands

```bash
portlease claim --ports .ports --env .env.local   # lease the names in .ports for this directory, write them to the env file
portlease claim --ports .ports --env .env.local --dry-run   # show what would happen, change nothing
portlease release                                 # free this directory's ports
portlease ls [--json]                             # every lease on the machine
```

- `--ports` and `--env` are both required, relative to the current directory. A missing one is a usage error, never an implicit dry run, so a forgotten flag in a setup script fails loudly.
- `--dir <dir>` leases for (or releases) another directory instead of the current one. Symlinks are resolved, so the same directory reached by two paths hits the same leases.
- `claim` prints `NAME=port` lines to stdout (valid `.env` content) and `Leased for <dir>:` to stderr.

## The ports file

One environment variable name per line. Blank lines and `#` comments are ignored, a repeated name counts once, an invalid name (`^[A-Za-z_][A-Za-z0-9_]*$`) is an error that names the line.

```
# .ports
WEB_PORT
API_PORT
```

## What `claim` does to the env file

- Replaces every `NAME=…` / `export NAME=…` line for a listed name with `NAME=port` (the old value and inline comments on that line are dropped), and appends names that are missing.
- Leaves every other line byte for byte, keeps CRLF, keeps the file mode (a new file gets 0644), and writes through a symlinked env file.
- Never reads values from the env file: the registry is the source of truth. So copy or generate the env file first, then `claim`, and the copied port values are overwritten.
- Is idempotent: running it again returns the same ports and rewrites the file. Use it to repair an env file that was regenerated. Names that were removed from the ports file keep their lease until `release`.

## One lease per name, one file per app

A lease is keyed on (directory, name). If two apps need the same port (a web app proxying to an API), give both ports files the same name: two `claim`s from the same directory, one per env file, write the same number into both.

```bash
portlease claim --ports apps/server/.ports --env apps/server/.env
portlease claim --ports apps/web/.ports --env apps/web/.env   # also lists API_PORT: same port as above
```

Two *different* names are always two different ports. If the API must be reachable as `PORT` for one app and `API_PORT` for another, they will not match; pick one name and make the app read it.

## Typical setup and archive scripts

```yaml
scripts:
  setup: |
    cp ../app/.env.local .env.local    # copy or generate the env file first
    portlease claim --ports .ports --env .env.local
  archive: portlease release
```

The main checkout does not need to claim anything; it keeps the application's default ports. `release` succeeds when there is nothing to release and also works for a directory that no longer exists (`portlease release --dir <gone-path>`), so it is safe in cleanup scripts. It does not touch env files.

## Allocation, in short

Ports come from `20000–29999` by default, allocated by a cursor that only moves forward (a freed port is reused only after the whole range has been walked, so a stale `.env` rarely points at someone else's port). A port is skipped if it is leased or busy right now. Change the range in `config.json` in the registry directory: `{ "range": { "min": 20000, "max": 29999 } }`; existing leases are not moved.

## Where things live

Registry directory: `$PORTLEASE_HOME`, else `$XDG_CONFIG_HOME/portlease`, else `~/.config/portlease`. It holds `leases.json`, optional `config.json` and `leases.lock`. Do not edit `leases.json` by hand; use `claim`, `release` and `ls`. Set `PORTLEASE_HOME` to a temp directory when experimenting or testing so the real registry stays clean.

A renamed or moved directory loses its leases (they are keyed on the path): run `claim` again in the new location.

## Exit codes and what to do

| Code | Meaning | What to do |
|---|---|---|
| 1 | Usage error: unknown command or option, missing `--ports`/`--env`, bad ports file, `--dir` not a directory | Read the message; it names the file and line |
| 2 | Range exhausted | `portlease ls` to see who holds ports, release stale ones, or widen the range |
| 3 | Registry problem (unreadable, invalid, or written by a newer portlease) | Fix or delete `leases.json` (deleting forgets every lease), or upgrade portlease |
| 4 | Registry locked for over 10 s | If no portlease is running, delete `leases.lock` |
| 5 | Env file could not be written | The ports are already leased: fix the path or permissions and run `claim` again |

## Adding portlease to a repository

Do these in order. The goal: every dev/test port comes from an env file, the main checkout and CI keep fixed ports, and a new worktree swaps in leased ports automatically.

1. **Inventory the fixed ports.** Search the code, scripts, configs and docs for hard-coded ports (`grep -rnE "localhost:[0-9]{4}|--port [0-9]+|PORT"`). Group them by the process that opens them (API, web dev server, proxy, Storybook, e2e servers and stubs). CI/Docker/production ports can stay as they are; leasing is for local dev and test.
2. **Pick one name per port, and read that name.** Use the variable the app already reads when there is one; otherwise add one (`API_PORT`, `WEB_PORT`, `E2E_API_PORT`, …). Dev and e2e ports need different names so they get different leases. A port two apps share (the API port a web proxy points at) gets the same name in both apps' files.
3. **Commit an `.env.example` per app with the fixed values** (`WEB_PORT=4000`, …), plus an e2e one if tests need ports. Make sure the real `.env` files are in `.gitignore`. The examples are the only place with fixed ports; remove fallbacks like `process.env.PORT ?? 4000` from code and fail with a message that says which variable is missing and how to create the file. A silent fallback quietly sends a leased worktree back to the shared port.
4. **Create the env files from the examples when missing.** A small `sh` script that copies `X.example` to `X` unless `X` exists, run from `postinstall` and also as a package script (`setup:env`) so it can be run by hand. Document it in the README. Use `#!/bin/sh`, not bash: Alpine-based Docker images have no bash, and a Dockerfile that installs before copying the sources needs the script copied first (or make the step manual).
5. **Write one ports file per env file**, next to it, listing the names that file must hold (`apps/server/.ports`, `apps/web/.ports`, `e2e/.ports`, …). Each file lists only what its app reads, so env files stay free of ports they never use.
6. **Wire the worktree scripts.** Install dependencies first (so the env files exist), then `claim` once per ports file, then the rest of the setup; release in archive:

   ```yaml
   scripts:
     setup: |
       pnpm install                      # creates the env files from the examples
       portlease claim --ports apps/server/.ports --env apps/server/.env
       portlease claim --ports apps/web/.ports --env apps/web/.env
       portlease claim --ports e2e/.ports --env .env.e2e
     archive: |
       portlease release
   ```

   If the setup runs on a different Node than the project pins, switch first (`nvm use`), because a global package lives under one Node version. An env file that holds real configuration which is not in git (database URL, keys) must be copied from the main checkout before the claim (Orca: list it in `.worktreeinclude`); `claim` then only replaces the port lines.
7. **Install portlease as a global tool, not as a project dependency.** CI and Docker builds should neither install nor run it: a git/tarball dependency needs `git` or network in places that have neither (an Alpine image re-resolves it during `pnpm deploy`), and CI does not lease ports. `npm i -g github:desclapez/portlease#v0.1.0` on each machine, and once per Node version under nvm (or list it in `$NVM_DIR/default-packages`).
8. **Verify before committing.** Use a throwaway registry so the real one stays clean:

   ```bash
   export PORTLEASE_HOME="$(mktemp -d)"
   portlease claim --ports apps/web/.ports --env apps/web/.env --dry-run   # what would change
   portlease claim --ports apps/server/.ports --env apps/server/.env
   portlease claim --ports apps/web/.ports --env apps/web/.env             # shared names match the server's
   portlease ls
   ```

   Then start the apps with those env files and check they listen on the leased ports, run the test suite, run `portlease release`, and delete the generated env files so the main checkout keeps the fixed ports. Restore any env file you had before (back up anything with real configuration first).

Do not run `claim` in the main checkout unless the user asks: it keeps the default ports on purpose.

## Working with this tool

- Check `portlease --help` and `portlease claim --dry-run` before changing a setup script: the dry run prints the ports it would assign and the env lines it would change or add.
- Do not invent or hard-code ports for a worktree that is supposed to be leased; ask `portlease ls` or read the env file `claim` wrote.
- Install (Node 22+): `npm i -g github:desclapez/portlease#v0.1.0`. With nvm, global packages are per Node version. Do not add it to a project's dependencies (see "Adding portlease to a repository").
