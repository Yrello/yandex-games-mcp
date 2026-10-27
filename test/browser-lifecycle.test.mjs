import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserLifecycle } from '../src/browser-lifecycle.mjs';

test('a failed browser start is closed and the next call creates a new client', async () => {
  const clients = [];
  const lifecycle = createBrowserLifecycle(() => {
    const client = {
      starts: 0, closes: 0,
      async start() {
        this.starts += 1;
        if (clients.length === 1) throw new Error('profile busy');
      },
      async close() { this.closes += 1; },
    };
    clients.push(client);
    return client;
  });

  await assert.rejects(lifecycle.start(), /profile busy/);
  assert.equal(clients[0].closes, 1);
  const recovered = await lifecycle.start();
  assert.equal(recovered, clients[1]);
  assert.equal(clients[1].starts, 1);
  await lifecycle.close();
  assert.equal(clients[1].closes, 1);
});

test('concurrent starts share one browser client', async () => {
  let created = 0;
  const lifecycle = createBrowserLifecycle(() => {
    created += 1;
    return { async start() {}, async close() {} };
  });
  const [first, second] = await Promise.all([lifecycle.start(), lifecycle.start()]);
  assert.equal(created, 1);
  assert.equal(first, second);
  await lifecycle.close();
});
