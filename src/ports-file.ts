import { readFileSync } from 'node:fs';
import { ExitCode, PortleaseError } from './errors.ts';

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parsePorts(content: string, label: string): string[] {
  const names: string[] = [];
  content.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    if (!NAME_PATTERN.test(line)) {
      throw new PortleaseError(`${label}:${index + 1}: "${line}" is not a valid variable name`, ExitCode.usage);
    }
    if (!names.includes(line)) names.push(line);
  });
  if (names.length === 0) {
    throw new PortleaseError(`${label}: no variable names found. Add one name per line, e.g. WEB_PORT`, ExitCode.usage);
  }
  return names;
}

export function readPortsFile(file: string): string[] {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    throw new PortleaseError(`cannot read ports file ${file}: ${(error as Error).message}`, ExitCode.usage);
  }
  return parsePorts(content, file);
}
