import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createTcpServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadLibrary } from "../src/registry.js";
import { RuntimeSupervisor } from "../src/runtime/supervisor.js";
import { createNexusServer } from "../src/server.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "runtime-game");
const deferred = () => Promise.withResolvers();

async function within(promise, ms = 3_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("operation did not finish within bound")), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function fixture(t, { loadGameLibrary, backendPort } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nexus-ws-lifecycle-"));
  const configPath = join(root, "nexus.config.json");
  await writeFile(configPath, JSON.stringify({ games: [{ path: fixtureRoot }] }));
  const [game] = await loadLibrary(configPath);
  const supervisor = new RuntimeSupervisor({
    startupTimeoutMs: 3_000, pollIntervalMs: 20, stopGracePeriodMs: 500,
  });
  await supervisor.start(game);
  let acquisitions = 0;
  let releases = 0;
  const referenceReleased = deferred();
  const acquire = supervisor.acquireActiveRuntime.bind(supervisor);
  supervisor.acquireActiveRuntime = (entry) => {
    const reference = acquire(entry);
    if (!reference) return null;
    acquisitions += 1;
    return { ...reference, ...(backendPort ? { port: backendPort } : {}), release() {
      releases += 1;
      reference.release();
      referenceReleased.resolve();
    } };
  };
  const server = createNexusServer(configPath, { supervisor, loadGameLibrary });
  const port = await listen(server);
  t.after(async () => {
    await supervisor.stop().catch(() => undefined);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { supervisor, server, port, referenceReleased: referenceReleased.promise,
    counts: () => ({ acquisitions, releases }) };
}

async function upgradeClient(port, server) {
  const upgraded = deferred();
  server.once("upgrade", (_, socket) => upgraded.resolve(socket));
  const client = connect(port, "127.0.0.1");
  client.on("error", () => undefined);
  await once(client, "connect");
  client.write("GET /games/runtime-fixture/socket HTTP/1.1\r\n"
    + "Host: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n");
  return { client, downstream: await within(upgraded.promise) };
}

for (const stage of ["target resolution", "backend handshake", "HTTP upgrade rejection"]) {
  test(`WebSocket TCP reset during ${stage} is handled and releases its runtime reference`, async (t) => {
    const resolving = deferred();
    const continueResolution = deferred();
    const backendAccepted = deferred();
    const backendClosed = deferred();
    let backend;
    let backendPort;
    if (stage !== "target resolution") {
      backend = createTcpServer((socket) => {
        socket.on("error", () => undefined);
        socket.once("close", () => backendClosed.resolve());
        socket.once("data", () => {
          if (stage === "HTTP upgrade rejection") {
            socket.write("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 100000\r\n\r\npartial");
          }
          backendAccepted.resolve();
        });
      });
      backendPort = await listen(backend);
      t.after(() => new Promise((resolve) => backend.close(resolve)));
    }
    const f = await fixture(t, {
      backendPort,
      loadGameLibrary: async (path) => {
        resolving.resolve();
        if (stage === "target resolution") await continueResolution.promise;
        return loadLibrary(path);
      },
    });
    const { client, downstream } = await upgradeClient(f.port, f.server);
    t.after(() => client.destroy());
    // node:test treats any uncaught socket error as a test failure. Leave error
    // handling entirely to production and check both guards precede our reset.
    assert.ok(downstream.listenerCount("error") >= 2);
    const closed = new Promise((resolve) => downstream.once("close", resolve));
    await within(resolving.promise);
    if (stage !== "target resolution") await within(backendAccepted.promise);
    if (stage === "HTTP upgrade rejection") {
      const [response] = await within(once(client, "data"));
      assert.match(response.toString(), /^HTTP\/1.1 503 /);
    }
    client.resetAndDestroy();
    await within(closed);
    continueResolution.resolve();
    // Resolution may acquire its reference after the reset; stop is ordered
    // after it so the test exercises release on that late resolution path too.
    await within(f.referenceReleased);
    await within(f.supervisor.stop());
    if (backend) await within(backendClosed.promise);
    assert.deepEqual(f.counts(), { acquisitions: 1, releases: 1 });
    assert.equal(f.supervisor.getActiveRuntime(), null);
  });
}
