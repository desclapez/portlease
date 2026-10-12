import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { isPortFree } from './free-port.ts';

function listen(host: string, port = 0): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

const portOf = (server: Server) => (server.address() as AddressInfo).port;
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe('isPortFree', () => {
  test('a port nobody listens on is free', async () => {
    const server = await listen('127.0.0.1');
    const port = portOf(server);
    await close(server);
    assert.equal(await isPortFree(port), true);
  });

  test('a port held on 127.0.0.1 is busy', async () => {
    const server = await listen('127.0.0.1');
    try {
      assert.equal(await isPortFree(portOf(server)), false);
    } finally {
      await close(server);
    }
  });

  test('a port held on 0.0.0.0 is busy', async () => {
    const server = await listen('0.0.0.0');
    try {
      assert.equal(await isPortFree(portOf(server)), false);
    } finally {
      await close(server);
    }
  });

  test('a port held on :: is busy', async (t) => {
    let server: Server;
    try {
      server = await listen('::');
    } catch {
      t.skip('IPv6 is not available on this machine');
      return;
    }
    try {
      assert.equal(await isPortFree(portOf(server)), false);
    } finally {
      await close(server);
    }
  });
});
