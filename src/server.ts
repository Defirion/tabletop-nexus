import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLibrary, toPublicGame } from "./registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(here, "../public");

const STATIC_FILES = new Map<string, { file: string; type: string }>([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

function json(response: ServerResponse, status: number, body: unknown): void {
  const content = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
    "cache-control": "no-store",
  });
  response.end(content);
}

export function createNexusServer(configPath: string) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/healthz") {
        json(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/games") {
        const games = await loadLibrary(configPath);
        json(response, 200, { games: games.map(toPublicGame) });
        return;
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const asset = STATIC_FILES.get(url.pathname);
        if (asset !== undefined) {
          const content = await readFile(resolve(publicRoot, asset.file));
          response.writeHead(200, {
            "content-type": asset.type,
            "content-length": content.length,
            "cache-control": "no-cache",
          });
          response.end(request.method === "HEAD" ? undefined : content);
          return;
        }
      }

      json(response, 404, { error: "NOT_FOUND" });
    } catch (error) {
      console.error(error);
      json(response, 500, { error: "INTERNAL_ERROR" });
    }
  });
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? "3000");
  const host = process.env.HOST ?? "0.0.0.0";
  const configPath = resolve(process.env.NEXUS_CONFIG ?? "nexus.config.json");

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT ?? "3000"}`);
  }

  const server = createNexusServer(configPath);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolveListen());
  });

  console.log(`Tabletop Nexus listening on http://${host}:${port}`);
  console.log(`Configuration: ${configPath}`);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main();
}
