#!/usr/bin/env node
import { main } from './cli.ts';

// The working directory may already be gone (an archive script running after the folder was removed).
// $PWD still names it, which is enough for `release`.
function currentDirectory(): string {
  try {
    return process.cwd();
  } catch {
    return process.env.PWD ?? '/';
  }
}

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: currentDirectory(),
  env: process.env,
});
