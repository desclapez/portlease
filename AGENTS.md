# portlease

## Node version

Before running any `node` or `npm` command (tests, build, typecheck), activate the version from `.nvmrc`:

```sh
source ~/.nvm/nvm.sh && nvm use
```

The shell default is Node 22.14, which cannot run `.ts` files directly, so `npm test` fails with `ERR_UNKNOWN_FILE_EXTENSION`. That is an environment problem, not a bug in the project. Do not work around it by changing `package.json`.
