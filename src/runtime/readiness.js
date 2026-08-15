import { request as nodeRequest } from "node:http";

export const NEXUS_STATUS_PATH = "/__nexus/status";
export const NEXUS_STATUS_SCHEMA = 1;
const MAX_STATUS_BYTES = 64 * 1024;

function invalid(reason) {
  return Object.freeze({ ready: false, valid: false, reason });
}

export function queryNexusStatus({
  host,
  port,
  requestTimeoutMs = 1_000,
  request = nodeRequest,
} = {}) {
  if (typeof host !== "string" || host.trim() === "") {
    throw new TypeError("host must be a non-empty string");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("port must be an integer between 1 and 65535");
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TypeError("requestTimeoutMs must be a positive finite number");
  }
  if (typeof request !== "function") {
    throw new TypeError("request must be a function");
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    const req = request(
      {
        host,
        port,
        method: "GET",
        path: NEXUS_STATUS_PATH,
        headers: { accept: "application/json" },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          settle(invalid(`status-${response.statusCode ?? "unknown"}`));
          return;
        }

        const contentType = String(response.headers["content-type"] ?? "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (contentType !== "application/json") {
          response.resume();
          settle(invalid("content-type"));
          return;
        }

        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_STATUS_BYTES) {
            req.destroy(new Error("Nexus status response exceeded size limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          if (bytes > MAX_STATUS_BYTES) {
            settle(invalid("body-too-large"));
            return;
          }

          let payload;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            settle(invalid("invalid-json"));
            return;
          }

          if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
            settle(invalid("invalid-payload"));
            return;
          }
          if (payload.schema !== NEXUS_STATUS_SCHEMA) {
            settle(invalid("unsupported-schema"));
            return;
          }
          if (typeof payload.ready !== "boolean") {
            settle(invalid("invalid-ready"));
            return;
          }

          settle(Object.freeze({
            ready: payload.ready,
            valid: true,
            reason: payload.ready ? "ready" : "not-ready",
          }));
        });
      },
    );

    req.once("error", () => settle(invalid("request-error")));
    req.setTimeout(requestTimeoutMs, () => req.destroy(new Error("Nexus status request timed out")));
    req.end();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForNexusReadiness({
  host,
  port,
  exitPromise,
  startupTimeoutMs = 30_000,
  pollIntervalMs = 200,
  requestTimeoutMs = 1_000,
  query = queryNexusStatus,
  sleep = delay,
  now = Date.now,
} = {}) {
  if (!exitPromise || typeof exitPromise.then !== "function") {
    throw new TypeError("exitPromise must be a promise");
  }
  for (const [name, value] of [
    ["startupTimeoutMs", startupTimeoutMs],
    ["pollIntervalMs", pollIntervalMs],
    ["requestTimeoutMs", requestTimeoutMs],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite number`);
    }
  }

  const deadline = now() + startupTimeoutMs;
  let lastReason = "no-response";

  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      const error = new Error(`game readiness timed out (${lastReason})`);
      error.code = "GAME_READINESS_TIMEOUT";
      throw error;
    }

    const outcome = await Promise.race([
      query({
        host,
        port,
        requestTimeoutMs: Math.min(requestTimeoutMs, Math.max(1, remaining)),
      }).then((status) => ({ type: "status", status })),
      exitPromise.then((exit) => ({ type: "exit", exit })),
    ]);

    if (outcome.type === "exit") {
      const error = new Error("game process exited before becoming ready");
      error.code = "GAME_EXITED_BEFORE_READY";
      error.exit = outcome.exit;
      throw error;
    }

    lastReason = outcome.status.reason;
    if (outcome.status.valid && outcome.status.ready) {
      return outcome.status;
    }

    const afterProbe = deadline - now();
    if (afterProbe <= 0) {
      continue;
    }

    const pause = await Promise.race([
      sleep(Math.min(pollIntervalMs, afterProbe)).then(() => ({ type: "delay" })),
      exitPromise.then((exit) => ({ type: "exit", exit })),
    ]);
    if (pause.type === "exit") {
      const error = new Error("game process exited before becoming ready");
      error.code = "GAME_EXITED_BEFORE_READY";
      error.exit = pause.exit;
      throw error;
    }
  }
}
