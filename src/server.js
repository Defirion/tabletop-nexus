import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGameProxy, parsePublicGameRoute } from "./game-proxy.js";
import { loadLibrary, toPublicGame } from "./registry.js";
import { RuntimeSupervisor } from "./runtime/supervisor.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(moduleDir, "../public");

const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/qr.js", { file: "qr.js", type: "text/javascript; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
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
  return runtime === null ? null : { gameId: runtime.gameId, status: runtime.status };
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
    ...(state.status === "failed" ? {
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
          if (!changed) console.error(error);
          sendJson(response, changed ? 409 : 503, {
            error: changed ? "RUNTIME_CHANGED" : "LIFECYCLE_FAILED",
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

  const server = createNexusServer(resolve(configPath), { supervisor });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  return server;
}

async function main() {
  const host = process.env.HOST ?? "0.0.0.0";
  const port = Number(process.env.PORT ?? "3000");
  const configPath = resolve(process.env.NEXUS_CONFIG ?? "nexus.config.json");
  const server = await startNexusServer({ host, port, configPath });
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
