import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ExitCode, PortleaseError } from './errors.ts';
import { canonicalPath } from './paths.ts';

export const MANIFEST_FILE = '.portlease';
export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type Section = { envFile: string; names: string[] };
export type Manifest = { dir: string; file: string; sections: Section[] };

const EXAMPLE = `Create one at the project root, for example:

[.env]
WEB_PORT
`;

const usage = (message: string) => new PortleaseError(message, ExitCode.usage);

// A committed manifest must not make claim write outside the project.
const isInsideProject = (path: string) => !isAbsolute(path) && !path.split(/[/\\]/).includes('..');

export function parseManifest(content: string, label: string): Section[] {
  const sections: Section[] = [];
  let current: { section: Section; line: number } | undefined;

  const closeSection = () => {
    if (current && current.section.names.length === 0) {
      throw usage(`${label}:${current.line}: [${current.section.envFile}] has no variable names. List one name per line below it`);
    }
  };

  content.split(/\r?\n/).forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;

    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      closeSection();
      const envFile = (header[1] ?? '').trim();
      if (envFile === '' || !isInsideProject(envFile)) {
        throw usage(`${label}:${lineNumber}: [${envFile}] must be a relative path inside the project`);
      }
      if (sections.some((section) => section.envFile === envFile)) {
        throw usage(`${label}:${lineNumber}: [${envFile}] appears twice. List all its names in one section`);
      }
      const section: Section = { envFile, names: [] };
      sections.push(section);
      current = { section, line: lineNumber };
      return;
    }

    if (!current) {
      throw usage(`${label}:${lineNumber}: "${line}" is outside a section. Start with the env file it goes to, e.g. [.env]`);
    }
    if (!NAME_PATTERN.test(line)) {
      throw usage(`${label}:${lineNumber}: "${line}" is not a valid variable name`);
    }
    if (!current.section.names.includes(line)) current.section.names.push(line);
  });

  closeSection();
  if (sections.length === 0) {
    throw usage(`${label}: no sections found. ${EXAMPLE}`);
  }
  return sections;
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export function findManifest(startDir: string): Manifest {
  let dir = canonicalPath(startDir);
  for (;;) {
    const file = join(dir, MANIFEST_FILE);
    if (isFile(file)) {
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch (error) {
        throw usage(`cannot read ${file}: ${(error as Error).message}`);
      }
      return { dir, file, sections: parseManifest(content, file) };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw usage(`no ${MANIFEST_FILE} found in ${resolve(startDir)} or any parent directory. ${EXAMPLE}`);
}

export function distinctNames(sections: readonly Section[]): string[] {
  const names: string[] = [];
  for (const section of sections) {
    for (const name of section.names) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}
