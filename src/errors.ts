export const ExitCode = {
  ok: 0,
  usage: 1,
  rangeExhausted: 2,
  registry: 3,
  lockTimeout: 4,
  envWrite: 5,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export class PortleaseError extends Error {
  readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode) {
    super(message);
    this.name = 'PortleaseError';
    this.exitCode = exitCode;
  }
}
