import { createServer } from 'node:net';

// All four are needed: on macOS a bind on one address can succeed while another holds the port.
export const PROBE_HOSTS = ['127.0.0.1', '::1', '0.0.0.0', '::'] as const;

function isFreeOn(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      // An address family the machine lacks cannot hold the port.
      resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT');
    });
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function isPortFree(port: number): Promise<boolean> {
  // Sequential on purpose: a dual-stack `::` bind collides with a concurrent `0.0.0.0` one.
  for (const host of PROBE_HOSTS) {
    if (!(await isFreeOn(port, host))) return false;
  }
  return true;
}
