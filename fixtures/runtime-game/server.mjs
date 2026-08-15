import { spawn } from "node:child_process";
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

const server = createServer((request, response) => {
  if (request.url === "/__nexus/status") {
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

  if (request.url === "/fixture") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ host, port, basePath }));
    return;
  }

  response.writeHead(404);
  response.end();
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
