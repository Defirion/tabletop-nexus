import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const host = process.env.HOST;
const port = Number(process.env.PORT);
const basePath = process.env.BASE_PATH;
const launchToken = process.env.NEXUS_LAUNCH_TOKEN;

if (!host || !Number.isInteger(port) || port < 1 || !basePath || !launchToken) {
  throw new Error("fixture requires HOST, PORT, BASE_PATH, and NEXUS_LAUNCH_TOKEN");
}

const options = new Map(
  process.argv.slice(2).map((arg) => {
    const index = arg.indexOf("=");
    return index === -1 ? [arg, true] : [arg.slice(0, index), arg.slice(index + 1)];
  }),
);
const readyDelayMs = Number(options.get("--ready-delay-ms") ?? "0");
const bindDelayMs = Number(options.get("--bind-delay-ms") ?? "0");
const outputBytes = Number(options.get("--output-bytes") ?? "0");
const statusMode = String(options.get("--status-mode") ?? "normal");
const signalFile = options.get("--signal-file");
const ignoreSigterm = options.has("--ignore-sigterm");
const helperListenerRoot = options.has("--helper-listener-root");
const helperListenerChild = options.has("--helper-listener-child");
const helperIgnoreSigterm = options.has("--helper-ignore-sigterm");
const runtimePidsFile = options.get("--runtime-pids-file");
const rootExitAfterMs = options.has("--root-exit-after-ms")
  ? Number(options.get("--root-exit-after-ms"))
  : null;
const exitAfterReadyMs = options.has("--exit-after-ready-ms")
  ? Number(options.get("--exit-after-ready-ms"))
  : null;
const readyAt = Date.now() + readyDelayMs;
let activeStreams = 0;
let streamSequence = 0;

async function noteSignal(signal) {
  if (typeof signalFile === "string") {
    await appendFile(signalFile, `${signal}\n`, "utf8");
  }
}

if (helperListenerRoot && !helperListenerChild) {
  const helperArgs = [fileURLToPath(import.meta.url), "--helper-listener-child"];
  if (helperIgnoreSigterm) {
    helperArgs.push("--ignore-sigterm");
  }
  const helper = spawn(process.execPath, helperArgs, {
    env: process.env,
    stdio: "ignore",
  });

  if (typeof runtimePidsFile === "string") {
    await writeFile(runtimePidsFile, `${process.pid}\n${helper.pid}\n`, "utf8");
  }

  process.on("SIGTERM", async () => {
    await noteSignal("SIGTERM");
    if (!ignoreSigterm) {
      process.exit(0);
    }
  });

  if (rootExitAfterMs !== null) {
    setTimeout(() => process.exit(17), Math.max(0, rootExitAfterMs));
  }

  await new Promise(() => {});
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://runtime.invalid");
  if (requestUrl.pathname === "/__nexus/status") {
    if (statusMode === "malformed") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{");
      return;
    }
    if (statusMode === "wrong-content-type") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(JSON.stringify({ schema: 2, ready: true, launchToken }));
      return;
    }
    if (statusMode === "trickle") {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      let ticks = 0;
      const interval = setInterval(() => {
        ticks += 1;
        if (ticks >= 100) {
          clearInterval(interval);
          response.end("}");
          return;
        }
        response.write(" ");
      }, 10);
      response.once("close", () => clearInterval(interval));
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({
      schema: 2,
      ready: Date.now() >= readyAt,
      launchToken,
    }));
    return;
  }

  if (requestUrl.pathname === "/events") {
    activeStreams += 1;
    streamSequence += 1;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(`id: ${streamSequence}\ndata: connected\n\n`);
    const interval = setInterval(() => response.write(": heartbeat\n\n"), 50);
    response.once("close", () => {
      clearInterval(interval);
      activeStreams -= 1;
    });
    return;
  }

  if (requestUrl.pathname === "/stream-state") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ activeStreams }));
    return;
  }

  if (requestUrl.pathname === "/fixture") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ host, port, basePath }));
    return;
  }

  const ordinaryRoute = requestUrl.pathname === "/"
    || requestUrl.pathname === "/api/echo"
    || requestUrl.pathname === "/__nexusx/status"
    || requestUrl.pathname === "/__nexus-status";
  if (ordinaryRoute) {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      host,
      port,
      basePath,
      method: request.method,
      url: request.url,
      forwarded: request.headers.forwarded ?? null,
      xForwardedFor: request.headers["x-forwarded-for"] ?? null,
      body: Buffer.concat(chunks).toString("utf8"),
    }));
    return;
  }

  response.writeHead(404);
  response.end();
});

function websocketFrame(payload) {
  const content = Buffer.from(payload, "utf8");
  if (content.length >= 126) {
    throw new Error("fixture WebSocket payload is too large");
  }
  return Buffer.concat([Buffer.from([0x81, content.length]), content]);
}

server.on("upgrade", (request, socket) => {
  const requestUrl = new URL(request.url ?? "/", "http://runtime.invalid");
  const key = request.headers["sec-websocket-key"];
  if (requestUrl.pathname !== "/socket" || typeof key !== "string") {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }

  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n"
    + "Upgrade: websocket\r\n"
    + "Connection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.write(websocketFrame(JSON.stringify({ url: request.url })));
  socket.on("data", (frame) => {
    if (frame.length < 2) {
      return;
    }
    const opcode = frame[0] & 0x0f;
    if (opcode === 0x08) {
      socket.end(Buffer.from([0x88, 0x00]));
    }
  });
});

process.on("SIGTERM", async () => {
  await noteSignal("SIGTERM");
  if (ignoreSigterm) {
    return;
  }
  server.close(() => process.exit(0));
});

async function writeOutput(stream, totalBytes) {
  let remaining = totalBytes;
  const chunk = Buffer.alloc(16 * 1024, "x");
  while (remaining > 0) {
    const current = remaining >= chunk.length
      ? chunk
      : chunk.subarray(0, remaining);
    remaining -= current.length;
    if (!stream.write(current)) {
      await once(stream, "drain");
    }
  }
}

if (outputBytes > 0) {
  await writeOutput(process.stdout, outputBytes);
  await writeOutput(process.stderr, outputBytes);
}

if (bindDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, bindDelayMs));
}

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen({ host, port, exclusive: true }, resolve);
});

if (exitAfterReadyMs !== null) {
  setTimeout(() => process.exit(17), Math.max(0, readyDelayMs + exitAfterReadyMs));
}
