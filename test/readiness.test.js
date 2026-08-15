import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { queryNexusStatus } from "../src/runtime/readiness.js";

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

test("queryNexusStatus accepts the fixed schema-1 ready payload and ignores unknown fields", async () => {
  await withStatusServer((request, response) => {
    assert.equal(request.url, "/__nexus/status");
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ schema: 1, ready: true, future: { rooms: 3 } }));
  }, async (port) => {
    assert.deepEqual(await queryNexusStatus({ host: "127.0.0.1", port }), {
      ready: true,
      valid: true,
      reason: "ready",
    });
  });
});

test("queryNexusStatus treats ready=false as valid but not ready", async () => {
  await withStatusServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ schema: 1, ready: false }));
  }, async (port) => {
    assert.deepEqual(await queryNexusStatus({ host: "127.0.0.1", port }), {
      ready: false,
      valid: true,
      reason: "not-ready",
    });
  });
});

test("queryNexusStatus fails closed for malformed or unsupported status responses", async () => {
  const cases = [
    { status: 503, type: "application/json", body: { schema: 1, ready: true }, reason: "status-503" },
    { status: 200, type: "text/plain", body: { schema: 1, ready: true }, reason: "content-type" },
    { status: 200, type: "application/json", raw: "{", reason: "invalid-json" },
    { status: 200, type: "application/json", body: { schema: 2, ready: true }, reason: "unsupported-schema" },
    { status: 200, type: "application/json", body: { schema: 1, ready: "yes" }, reason: "invalid-ready" },
  ];

  for (const fixture of cases) {
    await withStatusServer((_request, response) => {
      response.writeHead(fixture.status, { "content-type": fixture.type });
      response.end(fixture.raw ?? JSON.stringify(fixture.body));
    }, async (port) => {
      const result = await queryNexusStatus({ host: "127.0.0.1", port });
      assert.equal(result.ready, false);
      assert.equal(result.valid, false);
      assert.equal(result.reason, fixture.reason);
    });
  }
});
