import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadLibrary } from "../src/registry.js";
import { RuntimeSupervisor } from "../src/runtime/supervisor.js";
import { createNexusServer } from "../src/server.js";

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "runtime-game",
);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startRoutingFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nexus-routing-"));
  const configPath = join(root, "nexus.config.json");
  await writeFile(configPath, JSON.stringify({ games: [{ path: fixtureRoot }] }));
  const [game] = await loadLibrary(configPath);
  const supervisor = new RuntimeSupervisor({
    startupTimeoutMs: 3_000,
    pollIntervalMs: 20,
    requestTimeoutMs: 200,
    stopGracePeriodMs: 500,
  });
  await supervisor.start(game);
  const server = createNexusServer(configPath, { supervisor });
  const origin = await listen(server);

  t.after(async () => {
    await close(server);
    await supervisor.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return { origin, supervisor };
}

function rawGet(origin, path) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      method: "GET",
      path,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function waitForStreamCount(origin, expected) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/games/runtime-fixture/stream-state`);
    const state = await response.json();
    if (state.activeStreams === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`stream count did not become ${expected}`);
}

async function waitForDelayedHeaders(origin, expected) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/games/runtime-fixture/stream-state`);
    const state = await response.json();
    if (state.delayedHeaders === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`delayed-header count did not become ${expected}`);
}

function requestThatMustClose(origin, path, headers = {}) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: url.port,
      path,
      headers,
    });
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error(`timed out waiting for ${path} to close`));
    }, 1_000);
    request.once("response", (response) => {
      response.resume();
      response.once("end", () => {
        clearTimeout(timeout);
        reject(new Error(`${path} unexpectedly completed`));
      });
      response.once("aborted", () => {
        clearTimeout(timeout);
        resolve();
      });
      response.once("error", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    request.once("error", (error) => {
      if (error.code === "ECONNRESET") {
        clearTimeout(timeout);
        resolve();
        return;
      }
      clearTimeout(timeout);
      reject(error);
    });
    request.end();
  });
}

test("single-port HTTP routing strips BASE_PATH and preserves ordinary game routes", async (t) => {
  const { origin, supervisor } = await startRoutingFixture(t);
  const active = supervisor.getActiveRuntime();

  const rootResponse = await fetch(`${origin}/games/runtime-fixture/`);
  assert.equal(rootResponse.status, 200);
  assert.deepEqual(await rootResponse.json(), {
    host: active.host,
    port: active.port,
    basePath: "/games/runtime-fixture",
    method: "GET",
    url: "/",
    forwarded: null,
    xForwardedFor: null,
    xForwardedPrefix: null,
    xForwardedPort: null,
    body: "",
  });

  const apiResponse = await fetch(`${origin}/games/runtime-fixture/api/echo?room=blue`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      forwarded: "for=attacker.example",
      "x-forwarded-for": "203.0.113.4",
      "x-forwarded-prefix": "/attacker",
      "x-forwarded-port": "443",
    },
    body: JSON.stringify({ move: "north" }),
  });
  assert.equal(apiResponse.status, 200);
  const api = await apiResponse.json();
  assert.equal(api.method, "POST");
  assert.equal(api.url, "/api/echo?room=blue");
  assert.equal(api.forwarded, null);
  assert.equal(api.xForwardedFor, null);
  assert.equal(api.xForwardedPrefix, null);
  assert.equal(api.xForwardedPort, null);
  assert.equal(api.body, JSON.stringify({ move: "north" }));

  for (const path of ["__nexusx/status", "__nexus-status"]) {
    const response = await fetch(`${origin}/games/runtime-fixture/${path}`);
    assert.equal(response.status, 200, `${path} must remain game-owned`);
    assert.equal((await response.json()).url, `/${path}`);
  }

  assert.equal((await fetch(`${origin}/games/not-registered/`)).status, 404);
});

test("reserved management namespace and ambiguous canonicalization variants never reach the runtime", async (t) => {
  const { origin, supervisor } = await startRoutingFixture(t);
  const routes = [
    ["/games/runtime-fixture/__nexus/status", 404],
    ["/games/runtime-fixture/__NEXUS/status", 404],
    ["/games/runtime-fixture/__Nexus/status", 404],
    ["/games/runtime-fixture/%5f%5fNe%58uS/status", 404],
    ["/games/runtime-fixture/%5F%5FNEXUS/status", 404],
    ["/games/runtime-fixture%2f__NeXuS/status", 400],
    ["/games/runtime-fixture/%255f%255fNexus/status", 400],
    ["/games/runtime-fixture/%2e/__nexus/status", 400],
    ["/games/runtime-fixture/safe/%2e%2e/__nexus/status", 400],
    ["/games/runtime-fixture//__nexus/status", 400],
    ["/games/runtime-fixture/%2f__nexus/status", 400],
    ["/games/runtime-fixture/__nexus%3Bv/status", 404],
  ];

  for (const [path, expectedStatus] of routes) {
    const response = await rawGet(origin, path);
    assert.equal(response.status, expectedStatus, path);
    assert.equal(response.body.includes("launchToken"), false, path);
  }

  const active = supervisor.getActiveRuntime();
  const privateResponse = await fetch(`http://${active.host}:${active.port}/__nexus/status`);
  assert.equal(privateResponse.status, 200);
  const privateStatus = await privateResponse.json();
  assert.equal(privateStatus.schema, 2);
  assert.equal(privateStatus.ready, true);
  assert.equal(typeof privateStatus.launchToken, "string");
  assert.ok(privateStatus.launchToken.length > 0);
});

test("game mount root redirects to its trailing-slash canonical URL", async (t) => {
  const { origin } = await startRoutingFixture(t);
  const response = await fetch(`${origin}/games/runtime-fixture?room=blue`, { redirect: "manual" });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "/games/runtime-fixture/?room=blue");
});

test("path canonicalization preserves literal percent data but rejects encoded separators and aliases", async (t) => {
  const { origin } = await startRoutingFixture(t);
  const literalPercent = await rawGet(origin, "/games/runtime-fixture/api/100%25");
  assert.equal(literalPercent.status, 200);
  assert.equal(JSON.parse(literalPercent.body).url, "/api/100%25");
  for (const path of [
    "/games/%72untime-fixture/",
    "/games/runtime-fixture/api/a%2Fb",
    "/games/runtime-fixture/api/a%5Cb",
    "/games/runtime-fixture/api/a%252Fb",
  ]) {
    assert.equal((await rawGet(origin, path)).status, 400, path);
  }
});

test("SSE streams incrementally, clean up on disconnect, and reconnect through Nexus", async (t) => {
  const { origin } = await startRoutingFixture(t);

  async function connectAndCancel() {
    const response = await fetch(`${origin}/games/runtime-fixture/events`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/event-stream/);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /data: connected/);
    await waitForStreamCount(origin, 1);
    await reader.cancel();
    await waitForStreamCount(origin, 0);
    return text;
  }

  const first = await connectAndCancel();
  const second = await connectAndCancel();
  assert.notEqual(first.match(/id: (\d+)/)?.[1], second.match(/id: (\d+)/)?.[1]);
});

test("disconnect before backend headers cancels the backend request", async (t) => {
  const { origin } = await startRoutingFixture(t);
  const url = new URL(origin);
  const request = httpRequest({ host: url.hostname, port: url.port, path: "/games/runtime-fixture/delayed-headers" });
  request.once("error", () => undefined);
  request.end();
  await waitForDelayedHeaders(origin, 1);
  request.destroy();
  await waitForDelayedHeaders(origin, 0);
});

test("incomplete backend HTTP and SSE responses close the public response", async (t) => {
  const { origin } = await startRoutingFixture(t);
  await requestThatMustClose(origin, "/games/runtime-fixture/partial-response");
  await requestThatMustClose(origin, "/games/runtime-fixture/partial-events");
});

test("WebSocket upgrades share the Nexus game route and strip BASE_PATH", async (t) => {
  const { origin } = await startRoutingFixture(t);
  const socketUrl = `${origin.replace(/^http/u, "ws")}/games/runtime-fixture/socket?room=green`;

  const message = await new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("timed out waiting for fixture WebSocket message"));
    }, 2_000);
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      socket.close();
      resolve(event.data);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("fixture WebSocket failed"));
    }, { once: true });
  });

  assert.deepEqual(JSON.parse(message), { url: "/socket?room=green" });

  for (const path of [
    "/games/not-registered/socket",
    "/games/runtime-fixture/__NeXuS/socket",
  ]) {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${origin.replace(/^http/u, "ws")}${path}`);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`timed out waiting for rejected WebSocket ${path}`));
      }, 2_000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        socket.close();
        reject(new Error(`unexpected WebSocket upgrade for ${path}`));
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  }
});

test("incomplete HTTP rejection of a WebSocket upgrade closes the client socket", async (t) => {
  const { origin } = await startRoutingFixture(t);
  const url = new URL(origin);
  await new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for incomplete upgrade rejection to close"));
    }, 1_000);
    let response = "";
    socket.on("data", (chunk) => { response += chunk.toString("utf8"); });
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timeout);
      assert.match(response, /^HTTP\/1\.1 503 /u);
      resolve();
    });
    socket.write(
      "GET /games/runtime-fixture/upgrade-partial-response HTTP/1.1\r\n"
      + "Host: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
      + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    );
  });
});
