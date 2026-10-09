import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGameProxy, parsePublicGameRoute } from "./game-proxy.js";
import { loadLibrary, toPublicGame } from "./registry.js";
import { FileOwnershipJournal } from "./runtime/ownership-journal.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(moduleDir, "../public");

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/qr.js", { file: "qr.js", type: "text/javascript; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  // Bundled portal fonts (SIL Open Font License; see public/fonts/LICENSE-*.txt).
  ["/fonts/alfa-slab-one-latin-400-normal.woff2", { file: "fonts/alfa-slab-one-latin-400-normal.woff2", type: "font/woff2" }],
  ["/fonts/caveat-latin-600-normal.woff2", { file: "fonts/caveat-latin-600-normal.woff2", type: "font/woff2" }],
  ["/fonts/caveat-latin-700-normal.woff2", { file: "fonts/caveat-latin-700-normal.woff2", type: "font/woff2" }],
  ["/fonts/libre-baskerville-latin-400-normal.woff2", { file: "fonts/libre-baskerville-latin-400-normal.woff2", type: "font/woff2" }],
  ["/fonts/libre-baskerville-latin-400-italic.woff2", { file: "fonts/libre-baskerville-latin-400-italic.woff2", type: "font/woff2" }],
  ["/fonts/libre-baskerville-latin-700-normal.woff2", { file: "fonts/libre-baskerville-latin-700-normal.woff2", type: "font/woff2" }],
]);

function sendJson(response, status, body, method = "GET") {
  const content = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
    "cache-control": "no-store",
  });
  response.end(method === "HEAD" ? undefined : content);
}

function publicRuntime(supervisor) {
  const runtime = supervisor.getActiveRuntime();
  return runtime === null ? null : {
    gameId: runtime.gameId,
    status: runtime.status,
    ...(runtime.recovered === true ? { recovered: true } : {}),
  };
}

// Host-facing wording for a runtime left behind by a previous Nexus process.
// Process ids, paths and ownership evidence stay in the host console.
function recoveredMessage(status) {
  return status === "failed"
    ? "Nexus restarted while this game was running, and its leftover processes could not be confirmed stopped. Nexus will not start another game until they are gone. Stop them on the Nexus host (see its console); this clears by itself once they exit."
    : "Nexus restarted while this game was running. Nexus is waiting for the leftover session to finish shutting down; this ends the old session for its players.";
}

function publicGame(game, supervisor) {
  const metadata = toPublicGame(game);
  const state = supervisor.getState(metadata.id);
  const runtime = supervisor.acquireActiveRuntime(game);
  const ready = runtime !== null;
  runtime?.release();
  const basePath = `/games/${metadata.id}/`;
  return {
    ...metadata,
    status: state.status,
    ...(state.recovered === true && (state.status === "failed" || state.status === "stopping") ? {
      message: recoveredMessage(state.status),
    } : state.status === "failed" ? {
      message: supervisor.getActiveRuntime()?.gameId === metadata.id
        ? "Cleanup could not be confirmed. Retry Stop game. If it still fails, check the Nexus host console before restarting."
        : "The game could not run. Try starting it again; if it still fails, check its setup on the Nexus host.",
    } : {}),
    ...(state.status === "running" && !ready ? {
      message: "The game configuration changed. Restart the game to open it again.",
    } : {}),
    ...(ready ? {
      playUrl: basePath,
      ...(metadata.capabilities.dedicatedDisplay === true ? { boardUrl: `${basePath}board/` } : {}),
    } : {}),
  };
}

function isPortalAction(request) {
  // No CORS grant: cross-origin browsers cannot supply this custom header.
  // An Origin, when present, must also match this plain-HTTP LAN server.
  return request.headers["x-nexus-action"] === "1"
    && (request.headers.origin === undefined
      || request.headers.origin === `http://${request.headers.host}`)
    && (request.headers["sec-fetch-site"] === undefined
      || request.headers["sec-fetch-site"] === "same-origin");
}

export function createNexusServer(configPath, {
  supervisor = new RuntimeSupervisor(),
} = {}) {
  const proxy = createGameProxy({ configPath, loadLibrary, supervisor });
  let busy = false;
  const server = createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const gameRoute = parsePublicGameRoute(request.url);
      if (gameRoute.kind !== "not-game") {
        await proxy.handleHttp(request, response, gameRoute);
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");

      if ((method === "GET" || method === "HEAD") && url.pathname === "/healthz") {
        sendJson(response, 200, { ok: true }, method);
        return;
      }

      if ((method === "GET" || method === "HEAD") && url.pathname === "/api/games") {
        const games = await loadLibrary(configPath);
        sendJson(response, 200, {
          games: games.map((game) => publicGame(game, supervisor)),
          runtime: publicRuntime(supervisor),
          ...((supervisor.getRecovery?.() ?? null) === null ? {} : {
            recovery: {
              status: "blocked",
              message: "Nexus found a runtime record from a previous run that it cannot interpret, so it will not start a game. Check the Nexus host console for what to clear.",
            },
          }),
          busy,
        }, method);
        return;
      }

      // Match the raw target: encoded IDs, dot segments and path aliases must
      // never normalize into a lifecycle action.
      const action = /^\/api\/games\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(start|stop)$/.exec(request.url ?? "");
      if (method === "POST" && action !== null) {
        if (!isPortalAction(request)) {
          sendJson(response, 403, { error: "ACTION_FORBIDDEN" });
          return;
        }
        if (busy) {
          sendJson(response, 409, { error: "LIFECYCLE_BUSY" });
          return;
        }
        busy = true;
        try {
          const [, gameId, operation] = action;
          if (operation === "start") {
            const games = await loadLibrary(configPath);
            const game = games.find((entry) => entry.manifest.id === gameId);
            if (game === undefined) {
              sendJson(response, 404, { error: "GAME_NOT_FOUND" });
              return;
            }
            const active = supervisor.getActiveRuntime();
            if (request.headers["x-nexus-active-game"] !== (active?.gameId ?? "")) {
              sendJson(response, 409, { error: "RUNTIME_CHANGED" });
              return;
            }
            // Repeated Start on the same ready installation is idempotent.
            const runtime = supervisor.acquireActiveRuntime(game);
            if (runtime !== null) runtime.release();
            else await supervisor.start(game);
            sendJson(response, 200, { game: publicGame(game, supervisor) });
          } else {
            // Stop remains available even if local configuration is now invalid
            // or the active registration was removed. Check inside the queue.
            await supervisor.stop(gameId);
            sendJson(response, 200, { gameId, status: "stopped" });
          }
        } catch (error) {
          const changed = error?.code === "RUNTIME_CHANGED";
          const blocked = error?.code === "RECOVERY_BLOCKED";
          if (!changed) console.error(error);
          sendJson(response, changed || blocked ? 409 : 503, {
            error: changed ? "RUNTIME_CHANGED" : blocked ? "RECOVERY_BLOCKED" : "LIFECYCLE_FAILED",
          });
        } finally {
          busy = false;
        }
        return;
      }

      if (method === "GET" || method === "HEAD") {
        const asset = STATIC_FILES.get(url.pathname);
        if (asset !== undefined) {
          const content = await readFile(resolve(publicRoot, asset.file));
          response.writeHead(200, {
            "content-type": asset.type,
            "content-length": content.length,
            "cache-control": "no-cache",
          });
          response.end(method === "HEAD" ? undefined : content);
          return;
        }
      }

      sendJson(response, 404, { error: "NOT_FOUND" }, method);
    } catch (error) {
      console.error(error);
      sendJson(response, 500, { error: "INTERNAL_ERROR" }, request.method);
    }
  });
  server.on("upgrade", (request, socket, head) => {
    const route = parsePublicGameRoute(request.url);
    proxy.handleUpgrade(request, socket, head, route).catch((error) => {
      console.error(error);
      if (!socket.destroyed) {
        socket.end(
          "HTTP/1.1 500 Internal Server Error\r\n"
          + "Connection: close\r\n"
          + "Content-Length: 0\r\n\r\n",
        );
      }
    });
  });
  return server;
}

export async function startNexusServer({
  host = process.env.HOST ?? "0.0.0.0",
  port = Number(process.env.PORT ?? "3000"),
  configPath = resolve(process.env.NEXUS_CONFIG ?? "nexus.config.json"),
  supervisor = new RuntimeSupervisor(),
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${port}`);
  }

  // Establish what a previous Nexus process left behind before serving any
  // lifecycle state, so the portal's first answer is already truthful.
  await supervisor.recover?.();
  const server = createNexusServer(resolve(configPath), { supervisor });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  return server;
}

/**
 * Orderly shutdown: stop accepting connections, end the active game through the
 * normal supervised stop (so no runtime is left behind), then drop connections.
 * A game that cannot be confirmed stopped is reported; the next start verifies
 * it against its ownership record.
 */
export async function shutdownNexus(server, supervisor) {
  const closed = new Promise((resolveClose) => server.close(resolveClose));
  server.closeIdleConnections?.();
  // A keep-alive request may start a game while the first stop is running, so
  // the stop is repeated once the queue has drained.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await supervisor.stop();
    } catch (error) {
      console.error("Could not confirm the active game stopped during shutdown:", error);
    }
  }
  server.closeAllConnections?.();
  await closed;
}

async function main() {
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? "3000");
  const configPath = resolve(process.env.NEXUS_CONFIG ?? "nexus.config.json");
  const supervisor = new RuntimeSupervisor({
    journal: new FileOwnershipJournal(),
    logger: console,
  });
  const server = await startNexusServer({ host, port, configPath, supervisor });
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`Received ${signal}; stopping the active game before exit.`);
      shutdownNexus(server, supervisor).then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
  }
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  console.log(`Tabletop Nexus listening on http://${host}:${actualPort}`);
  console.log(`Configuration: ${configPath}`);
}

const invoked = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
