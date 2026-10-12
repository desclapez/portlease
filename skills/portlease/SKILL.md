---
name: portlease
description: Find every port a project opens during development and testing and lease them with the `portlease` CLI, so that parallel agents, worktrees, features or other projects on the same machine never collide. Use whenever the user mentions port collisions or "address already in use", running several agents/worktrees/branches of one project at once, a `.ports` file or `portlease`, or asks to audit a project's env files and dev/test scripts for ports — even if they do not name the tool.
---

# portlease

`portlease` hands out one unique port per (directory, variable name) from a registry shared by the whole machine, and writes the ports into an env file. Several worktrees of one project, or several projects, can then run dev servers at the same time without colliding. Applications never call it: they only read their environment.

Use it from whatever creates and destroys a working copy (Orca `setup` / `archive` scripts, a shell script, by hand).

## What this skill is for

An agent working on a project starts dev servers, test runners, stubs and tools. Each one opens a port. If every checkout of the project uses the same fixed ports, a second agent, another feature branch in a worktree, or an unrelated project that likes the same numbers will fail with "address already in use" or, worse, silently talk to the wrong server. portlease gives each directory its own ports; this skill's job is to **find all the ports that can collide, and then lease them**.

## Finding the ports to lease

Do an audit before changing anything. The goal is every port that a flow an agent could run would open: dev, build preview, unit/integration/e2e tests, Storybook or docs, database and service containers, proxies and stubs, debuggers.

1. **Find the env files.** `find . -name ".env*" -not -path "*/node_modules/*"` and note which are committed examples, which are gitignored, and which app reads each (a `.env` next to a `package.json`, `--env-file` flags, `dotenv` calls, framework conventions). Read every `*PORT*`, `*_URL`/`HOST` value that contains `localhost:<port>`.
2. **Read the places that start things.** Scripts in `package.json`/`Makefile`/`Procfile`/`justfile`/`scripts/`; `docker-compose*.yml` (host side of `ports:`); CI-only files are out of scope except to learn what the e2e expects; config files of the tools that serve or test (`vite.config.*`, `webpack*`, `next.config.*`, `playwright.config.*`, `cypress.config.*`, `vitest/jest` configs, `.storybook/`, framework configs); test setup files; stubs, mocks and proxies in `e2e/`, `tools/`, `test/`; READMEs and docs that list ports.
3. **Look for what is not written down.** Framework defaults that no file mentions are the most dangerous, because they collide silently: Next/Nuxt/Docusaurus 3000, Vite 5173 (and its HMR socket), webpack-dev-server 8080, Angular 4200, Astro 4321, Parcel 1234, Metro/Expo 8081, Storybook 6006, Prisma Studio 5555, Node `--inspect` 9229, Vitest UI, Playwright UI/report servers, Jupyter 8888, MailHog 1025/8025, local Postgres/MySQL/Redis containers. Also note tools that move to the next free port when theirs is busy (Vite does unless `strictPort`): that hides a collision until two servers point at each other.
4. **Check against reality when you can.** Start the dev and test flows (or read their logs) and run `lsof -nP -iTCP -sTCP:LISTEN` to see what actually opens a port, including children of the scripts. Anything the static read missed shows up here. Ask before running something heavy or with side effects.
5. **Classify each port.** Leave alone: ports the OS assigns (`listen(0)`, tests that pick a free port themselves), production/CI-only ports, and ports of services shared on purpose across checkouts. Lease: everything fixed that a dev, test or tooling flow opens in the project checkout.
6. **Report before editing.** Give the user a table: port, process, flow (dev/test/e2e/tooling), where it is defined (file:line), how it collides (same project in another checkout, or a likely clash with other projects), and the name you propose. Wait for agreement, then apply.

Naming rules that follow from the leases: dev and e2e/test ports need different names (different names are different leases); a port two apps share (a web proxy targeting the API) gets the same name in both apps' ports files; use the variable the app already reads when there is one.

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

Start from the agreed audit table. What is needed is small; everything else is a decision for the user or an optional improvement. Keep the three apart when you talk to them: do the needed part, ask about the decisions (with a recommendation), and offer the improvements one by one.

### Needed

1. **Name each leased port after the variable the app already reads** (`PORT` stays `PORT`, `VITE_API_PORT` stays that). Add a new variable only where the port is hard-coded today (a script flag like `vite --port 4000`, a constant in a stub or config, a tool default). Dev and test/e2e ports need different names, because different names are different leases. When two apps need the same port (a web proxy pointing at the API), they need the same *name* in both ports files, so pick one name for it; an app that reads it under another name can be mapped in its script.
2. **A ports file per env file** (see "The ports file"), listing the names that env file must hold.
3. **Every leased port is read from the environment** by the process that opens it (and by whatever points at it, such as a proxy). Make the smallest change that gets there.
4. **Setup and teardown scripts** that claim after the working copy exists and release when it goes away (next section).
5. **Verify** with a throwaway registry before finishing:

   ```bash
   export PORTLEASE_HOME="$(mktemp -d)"
   portlease claim --ports apps/web/.ports --env apps/web/.env --dry-run   # what would change
   portlease claim --ports apps/server/.ports --env apps/server/.env
   portlease claim --ports apps/web/.ports --env apps/web/.env             # shared names match the server's
   portlease ls
   ```

   Start the apps with those env files and check they listen on the leased ports, run the tests, run `portlease release`, then restore the env files you had before (back up anything with real configuration first). Never `claim` in the main checkout unless the user asks: it keeps the default ports on purpose.

Do not hand-edit a user's real, gitignored env file (secrets, local configuration). `claim` adds or replaces only the lines it owns; if a variable should be renamed, change the code or script and tell the user, instead of rewriting their file.

Install portlease as a global tool, not as a project dependency: CI and Docker builds should neither install nor run it (a git/tarball dependency needs `git` or network where there is none; an Alpine image re-resolves it during `pnpm deploy`), and CI does not lease ports. `npm i -g github:desclapez/portlease#v0.1.0` on each machine, and once per Node version under nvm (or list it in `$NVM_DIR/default-packages`).

### Ask the user (and recommend)

- **Where should the leased ports live?** One file at the root (`.env.local`) that every app and tool loads, or each app's own env file (`apps/server/.env`, `apps/web/.env`, …) plus one for tests. Recommend each app's own file when the apps already load one, because they read it with no extra code; recommend a single root file for a small repo with one or two processes. A root file means every consumer must be taught to load it (Vite `loadEnv`, `tsx --env-file`, Playwright `loadEnvFile`).
- **Which tool creates the working copies** (Orca, Conductor, Claude Code, plain `git worktree`), if the detection in the next section is not conclusive.
- **Shared services:** whether containers such as Postgres or Redis should be one per working copy or shared on purpose.
- **Where do the main checkout and CI run?** Default: they keep today's fixed ports and only new working copies lease.

### Propose as improvements (each optional)

- **Commit an `.env.example` per env file with the fixed values**, plus a small `sh` script that creates the real file from it when missing (from `postinstall` and as a manual script such as `pnpm setup:env`, documented in the README). The examples then become the single place that lists the default ports, and a fresh clone or worktree is runnable. Use `#!/bin/sh`, not bash: Alpine-based images have no bash, and a Dockerfile that installs before copying the sources needs the script copied first (or make the step manual).
- **Remove the fixed ports from the code** (`process.env.PORT ?? 4001`) and fail with a message naming the missing variable and how to create the file. A silent fallback quietly sends a leased working copy back to the shared port. Do this only together with the example files, so a missing file is easy to fix.
- **Make tools that hop to the next free port refuse to** (`strictPort` in Vite), so a collision is an error instead of two servers pointing at each other.
- **One name per shared port**, when the same port is read under different names in different places, to keep the ports files simple.

## Creating the setup and teardown scripts for worktrees and agents

The leases only help if every new working copy claims its ports and every removed one releases them. Write the scripts for the environment the user actually has, and ask when you cannot tell.

**Detect the environment.** `git worktree list` (where do the worktrees live?), and look for `orca.yaml` / `.worktreeinclude` (Orca), `conductor.json` (Conductor), `.claude/` and `CLAUDE.md` (Claude Code), other agent or IDE config, an existing `scripts/` convention, and how the project is installed (`pnpm`, `npm`, `uv`, …). Several can coexist. Do not assume one; if it is not clear which tool creates the working copies, ask.

**Keep the logic in one tool-agnostic script, and wire each tool to it.** That way plain `git worktree add`, Orca, and an agent that creates its own worktree all behave the same:

```sh
#!/bin/sh
# scripts/worktree-setup.sh — run from the new working copy's root
set -eu
main="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"   # the main checkout

# 1. Config that is not in git: copy it from the main checkout if it is missing here.
for f in apps/server/.env; do                                     # only files with real configuration
  [ -f "$f" ] || { [ -f "$main/$f" ] && mkdir -p "$(dirname "$f")" && cp "$main/$f" "$f"; }
done

# 2. Install (if the project has .env.example files and a setup-env script, this also creates the env files).
pnpm install

# 3. Lease ports: one claim per ports file / env file pair (a single root file needs only one claim). This replaces the port lines, nothing else.
portlease claim --ports apps/server/.ports --env apps/server/.env
portlease claim --ports apps/web/.ports --env apps/web/.env
portlease claim --ports e2e/.ports --env .env.e2e

# 4. Project-specific preparation (code generation, migrations, ...)
```

```sh
#!/bin/sh
# scripts/worktree-teardown.sh — release every lease of this working copy
portlease release
```

Rules that keep these scripts correct:
- Run `claim` after the install and after any copy of an env file, because both can bring fixed example ports back; `claim` then overwrites exactly the names in the ports files.
- Never run them in the main checkout (it keeps the fixed ports), so guard with a check if the tool can run them there: `[ "$(git rev-parse --show-toplevel)" = "$main" ] && exit 0`.
- `release` must not depend on anything inside the working copy that may already be gone; it is safe to run twice, and `portlease release --dir <path>` works for a path that no longer exists.
- If the environment switches Node versions or the shell is not the user's login shell (agent terminals often are not), load the version manager and switch first, because global packages such as portlease live under one Node version.

**Wire the tool.**
- **Orca** (`orca.yaml`): `scripts.setup: sh scripts/worktree-setup.sh` and `scripts.archive: sh scripts/worktree-teardown.sh`; list gitignored files that must be copied in `.worktreeinclude`.
- **Plain git:** `git worktree add ../x -b feature && (cd ../x && sh scripts/worktree-setup.sh)`; before `git worktree remove`, run the teardown. Git has no hook for removal, so say so in the README and consider a small wrapper alias.
- **Other agent environments** (Conductor, Claude Code worktrees, editor integrations): point their setup/archive (or create/remove) hook at the same two scripts. Check that tool's current documentation for the exact config key instead of guessing it, and tell the user which parts you could not verify.

After writing them, run the setup script in a throwaway worktree with a temporary `PORTLEASE_HOME` (see "Verify" above), check the generated env files and that `release` empties `portlease ls`, then remove the worktree.

## Working with this tool

- Check `portlease --help` and `portlease claim --dry-run` before changing a setup script: the dry run prints the ports it would assign and the env lines it would change or add.
- Do not invent or hard-code ports for a worktree that is supposed to be leased; ask `portlease ls` or read the env file `claim` wrote.
- Install (Node 22+): `npm i -g github:desclapez/portlease#v0.1.0`. With nvm, global packages are per Node version. Do not add it to a project's dependencies (see "Adding portlease to a repository").
