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
    let req;
    let timeoutId;
    const settle = (value) => {
      if (settled) {
        return false;
      }
      settled = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      resolve(value);
      return true;
    };
    const abort = (reason, message) => {
      if (settle(invalid(reason)) && req !== undefined) {
        req.destroy(new Error(message));
      }
    };

    // This is an absolute wall-clock probe deadline, not a socket inactivity
    // timeout. Response activity therefore cannot extend the request forever.
    timeoutId = setTimeout(
      () => abort("request-timeout", "Nexus status request exceeded its absolute deadline"),
      requestTimeoutMs,
    );

    try {
      req = request(
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
            if (settled) {
              return;
            }
            bytes += chunk.length;
            if (bytes > MAX_STATUS_BYTES) {
              abort("body-too-large", "Nexus status response exceeded size limit");
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => {
            if (settled) {
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
    } catch {
      settle(invalid("request-error"));
      return;
    }

    req.once("error", () => settle(invalid("request-error")));
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

    // queryNexusStatus treats this as an absolute wall-clock request deadline.
    // Capping it to the remaining startup budget means an in-flight probe cannot
    // outlive the supervisor's configured startup deadline, even if bytes trickle.
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
