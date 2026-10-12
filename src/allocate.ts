import { ExitCode, PortleaseError } from './errors.ts';

export type Range = { min: number; max: number };

export type Allocation = { port: number; cursor: number };

export async function allocatePort(options: {
  range: Range;
  cursor: number;
  taken: ReadonlySet<number>;
  isFree: (port: number) => Promise<boolean>;
}): Promise<Allocation> {
  const { range, taken, isFree } = options;
  const size = range.max - range.min + 1;
  const start = options.cursor >= range.min && options.cursor <= range.max ? options.cursor : range.min;

  for (let step = 0; step < size; step++) {
    const port = range.min + ((start - range.min + step) % size);
    if (taken.has(port)) continue;
    if (await isFree(port)) {
      return { port, cursor: port === range.max ? range.min : port + 1 };
    }
  }

  throw new PortleaseError(
    `range exhausted: no free port between ${range.min} and ${range.max}. Run "portlease ls" to see who holds them, or widen the range in config.json`,
    ExitCode.rangeExhausted,
  );
}
