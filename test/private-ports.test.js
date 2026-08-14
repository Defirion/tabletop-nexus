import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { PRIVATE_GAME_HOST, PrivatePortAllocator } from "../src/runtime/private-ports.js";

async function listen(server, options) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function scriptedProbeFactory(ports) {
  const attempts = [];
  return {
    attempts,
    createProbe: async () => {
      assert.ok(ports.length > 0, "scripted probe ran out of candidates");
      const port = ports.shift();
      const attempt = { port, closeCount: 0 };
      attempts.push(attempt);
      return {
        port,
        close: async () => {
          attempt.closeCount += 1;
        },
      };
    },
  };
}

test("private port leases use loopback and remain unique while live", async () => {
  const allocator = new PrivatePortAllocator();
  const leases = await Promise.all(Array.from({ length: 24 }, () => allocator.allocate()));

  try {
    assert.equal(new Set(leases.map(({ port }) => port)).size, leases.length);
    for (const lease of leases) {
      assert.equal(lease.host, "127.0.0.1");
      assert.equal(lease.host, PRIVATE_GAME_HOST);
      assert.ok(Number.isInteger(lease.port));
      assert.ok(lease.port > 0 && lease.port <= 65535);
    }
  } finally {
    for (const lease of leases) {
      lease.release();
    }
  }
});

test("allocator rejects a replayed live candidate after probe release and accepts it after lease release", async () => {
  const probes = scriptedProbeFactory([41001, 41001, 41002, 41001]);
  const allocator = new PrivatePortAllocator({ createProbe: probes.createProbe });

  const first = await allocator.allocate();
  assert.equal(first.port, 41001);
  assert.equal(probes.attempts[0].closeCount, 1);

  const second = await allocator.allocate();
  assert.equal(second.port, 41002);
  assert.deepEqual(
    probes.attempts.slice(0, 3).map(({ port }) => port),
    [41001, 41001, 41002],
  );
  assert.equal(probes.attempts[1].closeCount, 1);
  assert.equal(probes.attempts[2].closeCount, 1);

  assert.equal(first.release(), true);
  const reused = await allocator.allocate();
  assert.equal(reused.port, 41001);
  assert.equal(probes.attempts[3].closeCount, 1);

  assert.equal(second.release(), true);
  assert.equal(reused.release(), true);
});

test("allocator does not select a port that is already bound on the private host", async (t) => {
  const occupied = createServer();
  t.after(() => close(occupied));
  const occupiedPort = await listen(occupied, { host: PRIVATE_GAME_HOST, port: 0, exclusive: true });

  const allocator = new PrivatePortAllocator();
  const lease = await allocator.allocate();
  try {
    assert.notEqual(lease.port, occupiedPort);
  } finally {
    lease.release();
  }
});

test("selected ports are released by the probe so a game can bind them", async (t) => {
  const allocator = new PrivatePortAllocator();
  const lease = await allocator.allocate();
  const game = createServer();
  t.after(() => close(game));

  const boundPort = await listen(game, { host: lease.host, port: lease.port, exclusive: true });
  assert.equal(boundPort, lease.port);
  assert.equal(lease.release(), true);
});

test("lease release is idempotent and the allocator remains usable", async () => {
  const allocator = new PrivatePortAllocator();
  const first = await allocator.allocate();

  assert.equal(first.release(), true);
  assert.equal(first.release(), false);

  const second = await allocator.allocate();
  assert.equal(second.host, PRIVATE_GAME_HOST);
  assert.equal(second.release(), true);
});
