import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { verifyPublicGameCompatibility } from "../src/game-compatibility.js";

const game = {
  manifest: {
    id: "fixture-game",
    capabilities: { tvLess: true, dedicatedDisplay: true },
  },
};

function response(status, location) {
  return {
    status,
    headers: new Headers(location === undefined ? {} : { location }),
  };
}

test("public compatibility check accepts an in-base-path redirect", async () => {
  const seen = [];
  const result = await verifyPublicGameCompatibility({
    origin: "https://nexus.example",
    game,
    fetchImpl: async (url) => {
      seen.push(url.toString());
      if (url.pathname === "/games/fixture-game/board/") {
        return response(302, "./select-room");
      }
      return response(200);
    },
  });
  assert.deepEqual(seen, [
    "https://nexus.example/games/fixture-game/",
    "https://nexus.example/games/fixture-game/board/",
    "https://nexus.example/games/fixture-game/board/select-room",
  ]);
  assert.equal(result.dedicatedDisplay.url, "https://nexus.example/games/fixture-game/board/select-room");
});

test("public compatibility check rejects redirects outside the game base path", async () => {
  await assert.rejects(
    verifyPublicGameCompatibility({
      origin: "https://nexus.example",
      game,
      fetchImpl: async (url) => (
        url.pathname.endsWith("/board/") ? response(302, "https://elsewhere.example/") : response(200)
      ),
    }),
    /outside its public same-origin base path/,
  );
});

test("board checks are required only for an advertised dedicated display", async (t) => {
  for (const dedicatedDisplay of [undefined, false, true]) {
    await t.test(String(dedicatedDisplay), async () => {
      const seen = [];
      const check = verifyPublicGameCompatibility({
        origin: "https://nexus.example",
        game: { manifest: { ...game.manifest, capabilities: { tvLess: true, dedicatedDisplay } } },
        fetchImpl: async (url, options) => {
          assert.equal(options.redirect, "manual");
          seen.push(url.pathname);
          return response(url.pathname.endsWith("/board/") ? 404 : 200);
        },
      });
      if (dedicatedDisplay === true) {
        await assert.rejects(check, /dedicated display entrypoint returned HTTP 404/);
        assert.equal(seen.length, 2);
      } else {
        const result = await check;
        assert.equal("dedicatedDisplay" in result, false);
        assert.deepEqual(seen, ["/games/fixture-game/"]);
      }
    });
  }
});

test("unsafe redirect targets are rejected before fetching them", async (t) => {
  const targets = [
    "https://elsewhere.example/games/fixture-game/",
    "http://nexus.example/games/fixture-game/",
    "https://nexus.example:8443/games/fixture-game/",
    "/", "/games/sibling/", "/games/fixture-game-lookalike/", "../../portal",
    "/games/fixture-game/__NEXUS/status",
    "/games/fixture-game/%5f%5fNe%58uS/status",
    "/games/fixture-game/%255f%255fnexus/status",
    "/games/fixture-game/safe%2f..%2foutside",
    "/games/fixture-game/room;ignored/",
    "https://credential@nexus.example/games/fixture-game/",
  ];
  for (const target of targets) {
    await t.test(target, async () => {
      let requests = 0;
      await assert.rejects(verifyPublicGameCompatibility({
        origin: "https://nexus.example",
        game,
        fetchImpl: async () => {
          requests += 1;
          assert.equal(requests, 1, "unsafe target must not be fetched");
          return response(302, target);
        },
      }), /outside its public same-origin base path|invalid or reserved public game route/);
      assert.equal(requests, 1);
    });
  }
});

test("unusable landing responses fail with their route and reason", async (t) => {
  for (const [status, location, expected] of [
    [404, undefined, /player landing page returned HTTP 404/],
    [503, undefined, /player landing page returned HTTP 503/],
    [304, undefined, /player landing page returned HTTP 304/],
    [302, undefined, /redirected without a Location header/],
    [302, "http://[", /redirected to an invalid URL/],
  ]) {
    await t.test(`${status} ${location}`, async () => {
      await assert.rejects(verifyPublicGameCompatibility({
        origin: "https://nexus.example", game,
        fetchImpl: async () => response(status, location),
      }), expected);
    });
  }
});

test("all navigation redirect statuses stay contained and five redirects may succeed", async () => {
  const statuses = [301, 302, 303, 307, 308];
  let requests = 0;
  const result = await verifyPublicGameCompatibility({
    origin: "https://nexus.example", game,
    fetchImpl: async () => {
      const status = statuses[requests++];
      return status === undefined ? response(200) : response(status, `./step-${requests}`);
    },
  });
  assert.equal(result.playerLanding.url, "https://nexus.example/games/fixture-game/step-5");
  assert.equal(requests, 7); // Six landing requests, then the optional board.
});

test("redirect loops stop after the bounded number of requests", async () => {
  let requests = 0;
  await assert.rejects(verifyPublicGameCompatibility({
    origin: "https://nexus.example", game,
    fetchImpl: async () => { requests += 1; return response(302, "./"); },
  }), /player landing page exceeded the redirect limit/);
  assert.equal(requests, 6);
});

test("invalid route identities and origins fail before making requests", async () => {
  const fetchImpl = async () => assert.fail("invalid input must not be fetched");
  for (const id of ["../sibling", "fixture-game/../../portal", "Upper", "", undefined]) {
    await assert.rejects(verifyPublicGameCompatibility({
      origin: "https://nexus.example", game: { manifest: { ...game.manifest, id } }, fetchImpl,
    }), /game.manifest.id/);
  }
  for (const origin of ["file:///tmp/nexus", "https://credential@nexus.example"]) {
    await assert.rejects(verifyPublicGameCompatibility({ origin, game, fetchImpl }), /origin must be/);
  }
  for (const capabilities of [[], undefined, { tvLess: false }, { tvLess: true, dedicatedDisplay: "false" }]) {
    await assert.rejects(verifyPublicGameCompatibility({
      origin: "https://nexus.example", game: { manifest: { ...game.manifest, capabilities } }, fetchImpl,
    }), /game.manifest.capabilities/);
  }
  await assert.rejects(verifyPublicGameCompatibility({
    origin: "https://nexus.example", game, fetchImpl, requestTimeoutMs: 0,
  }), /requestTimeoutMs/);
});

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("the route checker closes response bodies without waiting for a streamed page to finish", async (t) => {
  let closed;
  const disconnected = new Promise((resolve) => { closed = resolve; });
  const origin = await serve(t, (_request, reply) => {
    reply.writeHead(200);
    reply.write("unfinished landing page");
    reply.on("close", closed);
  });
  const result = await verifyPublicGameCompatibility({
    origin, game: { manifest: { id: "fixture-game", capabilities: { tvLess: true } } },
    requestTimeoutMs: 500,
  });
  assert.equal(result.playerLanding.status, 200);
  await disconnected;
});

test("the route checker times out a landing endpoint that never sends headers", async (t) => {
  const origin = await serve(t, () => {});
  await assert.rejects(verifyPublicGameCompatibility({ origin, game, requestTimeoutMs: 100 }),
    { name: "TimeoutError" });
});
