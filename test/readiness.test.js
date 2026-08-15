import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { queryNexusStatus } from "../src/runtime/readiness.js";

const launchToken = "test-launch-token";

async function withStatusServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const { port } = server.address();
  try {
    await callback(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("queryNexusStatus accepts the fixed schema-2 ready payload for the expected launch and ignores unknown fields", async () => {
  await withStatusServer((request, response) => {
    assert.equal(request.url, "/__nexus/status");
    assert.equal(request.headers["x-nexus-launch-token"], undefined);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      schema: 2,
      ready: true,
      launchToken,
      future: { rooms: 3 },
    }));
  }, async (port) => {
    assert.deepEqual(await queryNexusStatus({
      host: "127.0.0.1",
      port,
      launchToken,
    }), {
      ready: true,
      valid: true,
      reason: "ready",
    });
  });
});

test("queryNexusStatus treats ready=false as valid but not ready for the expected launch", async () => {
  await withStatusServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ schema: 2, ready: false, launchToken }));
  }, async (port) => {
    assert.deepEqual(await queryNexusStatus({
      host: "127.0.0.1",
      port,
      launchToken,
    }), {
      ready: false,
      valid: true,
      reason: "not-ready",
    });
  });
});

test("queryNexusStatus rejects a valid-looking responder that is not the expected launch", async () => {
  await withStatusServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schema: 2,
      ready: true,
      launchToken: "different-launch-token",
    }));
  }, async (port) => {
    assert.deepEqual(await queryNexusStatus({
      host: "127.0.0.1",
      port,
      launchToken,
    }), {
      ready: false,
      valid: false,
      reason: "launch-token-mismatch",
    });
  });
});

test("queryNexusStatus fails closed for malformed or unsupported status responses", async () => {
  const cases = [
    { status: 503, type: "application/json", body: { schema: 2, ready: true, launchToken }, reason: "status-503" },
    { status: 200, type: "text/plain", body: { schema: 2, ready: true, launchToken }, reason: "content-type" },
    { status: 200, type: "application/json", raw: "{", reason: "invalid-json" },
    { status: 200, type: "application/json", body: { schema: 1, ready: true }, reason: "unsupported-schema" },
    { status: 200, type: "application/json", body: { schema: 2, ready: "yes", launchToken }, reason: "invalid-ready" },
    { status: 200, type: "application/json", body: { schema: 2, ready: true }, reason: "launch-token-mismatch" },
  ];

  for (const fixture of cases) {
    await withStatusServer((_request, response) => {
      response.writeHead(fixture.status, { "content-type": fixture.type });
      response.end(fixture.raw ?? JSON.stringify(fixture.body));
    }, async (port) => {
      const result = await queryNexusStatus({
        host: "127.0.0.1",
        port,
        launchToken,
      });
      assert.equal(result.ready, false);
      assert.equal(result.valid, false);
      assert.equal(result.reason, fixture.reason);
    });
  }
});

test("queryNexusStatus enforces an absolute request deadline while response bytes keep arriving", async () => {
  await withStatusServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
      if (ticks >= 30) {
        clearInterval(interval);
        response.end("}");
        return;
      }
      response.write(" ");
    }, 10);
    response.once("close", () => clearInterval(interval));
  }, async (port) => {
    const startedAt = Date.now();
    const result = await queryNexusStatus({
      host: "127.0.0.1",
      port,
      launchToken,
      requestTimeoutMs: 60,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.deepEqual(result, {
      ready: false,
      valid: false,
      reason: "request-timeout",
    });
    assert.ok(elapsedMs < 200, `absolute request deadline took ${elapsedMs}ms`);
  });
});
