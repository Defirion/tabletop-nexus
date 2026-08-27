import { request as httpRequest } from "node:http";

const GAME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const UNTRUSTED_FORWARDING_HEADERS = new Set([
  "forwarded",
  "cf-connecting-ip",
  "cf-ray",
]);

function asciiEqualsIgnoreCase(value, expected) {
  if (value.length !== expected.length) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const folded = code >= 65 && code <= 90 ? code + 32 : code;
    if (folded !== expected.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

function encodePath(segments, trailingSlash) {
  if (segments.length === 0) {
    return "/";
  }
  const path = `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  return trailingSlash ? `${path}/` : path;
}

export function parsePublicGameRoute(requestTarget) {
  if (typeof requestTarget !== "string" || !requestTarget.startsWith("/games/")) {
    return { kind: "not-game" };
  }

  const queryIndex = requestTarget.indexOf("?");
  const rawPath = queryIndex === -1 ? requestTarget : requestTarget.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : requestTarget.slice(queryIndex);
  if (rawPath.includes("#") || /[\u0000-\u0020\u007f]/u.test(query)) {
    return { kind: "invalid" };
  }

  // Split before decoding. Decoding the entire path first would turn an encoded
  // slash into a route separator and change the game-visible route boundary.
  if (rawPath.includes("\\") || rawPath.includes("//")) {
    return { kind: "invalid" };
  }
  const rawSegments = rawPath.split("/");
  let segments;
  try {
    segments = rawSegments.map((segment) => decodeURIComponent(segment));
  } catch {
    return { kind: "invalid" };
  }
  // An encoded separator, backslash, control, or a second encoded escape has
  // different meanings in common backend routers, so fail closed. A lone
  // decoded percent (for example, `100%25`) remains valid path data.
  if (segments.some((segment) => (
    segment.includes("/")
    || segment.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(segment)
    || /%[0-9a-f]{2}/iu.test(segment)
  ))) {
    return { kind: "invalid" };
  }

  const trailingSlash = rawPath.endsWith("/");
  if (
    segments[0] !== ""
    || segments[1] !== "games"
    || !GAME_ID_PATTERN.test(segments[2] ?? "")
    || rawSegments[2] !== segments[2]
  ) {
    return { kind: "invalid" };
  }

  const gameSegments = segments.slice(3);
  if (trailingSlash) {
    gameSegments.pop();
  }
  // A backend may discard matrix parameters before doing normal path
  // canonicalization.  Reject them on every post-prefix segment: otherwise a
  // matrix-qualified dot or empty segment could normalize into __nexus.
  if (gameSegments.some((segment) => (
    segment === "" || segment === "." || segment === ".." || segment.includes(";")
  ))) {
    return { kind: "invalid" };
  }
  if (
    gameSegments[0] !== undefined
    && asciiEqualsIgnoreCase(gameSegments[0], "__nexus")
  ) {
    return { kind: "reserved" };
  }

  return {
    kind: "game",
    gameId: segments[2],
    backendPath: `${encodePath(gameSegments, trailingSlash)}${query}`,
    canonicalRootLocation: gameSegments.length === 0 && !trailingSlash
      ? `/games/${segments[2]}/${query}`
      : undefined,
  };
}

function connectionHeaderNames(headers) {
  const names = new Set();
  const connection = headers.connection;
  const values = Array.isArray(connection) ? connection : [connection];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    for (const name of value.split(",")) {
      names.add(name.trim().toLowerCase());
    }
  }
  return names;
}

function proxyRequestHeaders(headers, upgrade) {
  const connectionNames = connectionHeaderNames(headers);
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (
      value === undefined
      || HOP_BY_HOP_HEADERS.has(lowerName)
      || connectionNames.has(lowerName)
      || UNTRUSTED_FORWARDING_HEADERS.has(lowerName)
      || lowerName.startsWith("x-forwarded-")
      || lowerName === "sec-websocket-extensions"
    ) {
      continue;
    }
    result[lowerName] = value;
  }
  if (upgrade) {
    result.connection = "Upgrade";
    result.upgrade = headers.upgrade;
  }
  return result;
}

function proxyResponseHeaders(headers, upgrade = false) {
  const connectionNames = connectionHeaderNames(headers);
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (value === undefined) {
      continue;
    }
    const hopByHop = HOP_BY_HOP_HEADERS.has(lowerName) || connectionNames.has(lowerName);
    const requiredUpgradeHeader = upgrade && (lowerName === "connection" || lowerName === "upgrade");
    if ((hopByHop && !requiredUpgradeHeader) || lowerName === "sec-websocket-extensions") {
      continue;
    }
    result[lowerName] = value;
  }
  return result;
}

function sendJson(response, status, body, method = "GET") {
  const content = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
    "cache-control": "no-store",
  });
  response.end(method === "HEAD" ? undefined : content);
}

function sendSocketResponse(socket, status, reason, body = "") {
  if (socket.destroyed) {
    return;
  }
  const content = Buffer.from(body);
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n`
      + "Connection: close\r\n"
      + "Content-Type: application/json; charset=utf-8\r\n"
      + `Content-Length: ${content.length}\r\n\r\n`
      + body,
  );
}

function writeUpgradeHead(socket, response) {
  const headers = proxyResponseHeaders(response.headers, true);
  const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage ?? "Switching Protocols"}`];
  for (const [name, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      lines.push(`${name}: ${item}`);
    }
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
}

export function createGameProxy({ configPath, loadLibrary, supervisor }) {
  if (typeof loadLibrary !== "function") {
    throw new TypeError("loadLibrary must be a function");
  }
  if (!supervisor || typeof supervisor.acquireActiveRuntime !== "function") {
    throw new TypeError("supervisor.acquireActiveRuntime must be a function");
  }

  async function resolveTarget(route) {
    const library = await loadLibrary(configPath);
    const game = library.find((candidate) => candidate.manifest.id === route.gameId);
    if (game === undefined) {
      return { kind: "not-found" };
    }
    const runtime = supervisor.acquireActiveRuntime(game);
    if (runtime === null) {
      return { kind: "unavailable" };
    }
    return { kind: "target", runtime };
  }

  async function handleHttp(request, response, route) {
    if (route.kind !== "game") {
      sendJson(response, route.kind === "invalid" ? 400 : 404, {
        error: route.kind === "invalid" ? "INVALID_GAME_ROUTE" : "NOT_FOUND",
      }, request.method);
      return;
    }
    if (route.canonicalRootLocation !== undefined) {
      response.writeHead(308, { location: route.canonicalRootLocation });
      response.end();
      return;
    }

    let backendRequest;
    let backendResponse;
    let downstreamClosed = false;
    let releaseTarget = () => undefined;
    const cancelUpstream = () => {
      backendResponse?.destroy();
      backendRequest?.destroy();
      releaseTarget();
    };
    // A complete incoming request can still have a disconnected response. This
    // listener must exist before asynchronous target resolution begins.
    response.once("close", () => {
      downstreamClosed = true;
      cancelUpstream();
    });
    request.once("aborted", () => {
      downstreamClosed = true;
      cancelUpstream();
    });

    const target = await resolveTarget(route);
    if (downstreamClosed || response.destroyed) {
      if (target.kind === "target") {
        target.runtime.release();
      }
      return;
    }
    if (target.kind === "not-found") {
      sendJson(response, 404, { error: "NOT_FOUND" }, request.method);
      return;
    }
    if (target.kind === "unavailable") {
      sendJson(response, 503, { error: "GAME_UNAVAILABLE" }, request.method);
      return;
    }
    releaseTarget = target.runtime.release;

    try {
      backendRequest = httpRequest({
        host: target.runtime.host,
        port: target.runtime.port,
        method: request.method,
        path: route.backendPath,
        headers: proxyRequestHeaders(request.headers, false),
      });
    } catch {
      releaseTarget();
      sendJson(response, 400, { error: "INVALID_GAME_ROUTE" }, request.method);
      return;
    }

    backendRequest.once("socket", (backendSocket) => {
      if (backendSocket.connecting) {
        backendSocket.once("connect", releaseTarget);
      } else {
        queueMicrotask(releaseTarget);
      }
      backendSocket.once("error", releaseTarget);
    });

    backendRequest.once("response", (incomingResponse) => {
      backendResponse = incomingResponse;
      if (downstreamClosed || response.destroyed) {
        backendResponse.destroy();
        return;
      }
      response.writeHead(
        backendResponse.statusCode ?? 502,
        proxyResponseHeaders(backendResponse.headers),
      );
      backendResponse.pipe(response);
      const destroyDownstream = () => {
        if (!response.destroyed) {
          response.destroy();
        }
      };
      backendResponse.once("aborted", destroyDownstream);
      backendResponse.once("error", destroyDownstream);
      backendResponse.once("close", () => {
        if (!backendResponse.complete) {
          destroyDownstream();
        }
      });
    });
    backendRequest.once("error", () => {
      releaseTarget();
      if (downstreamClosed || response.destroyed) {
        return;
      }
      if (!response.headersSent) {
        sendJson(response, 502, { error: "GAME_UNAVAILABLE" }, request.method);
      } else {
        response.destroy();
      }
    });
    if (downstreamClosed || response.destroyed) {
      releaseTarget();
      backendRequest.destroy();
      return;
    }
    request.pipe(backendRequest);
  }

  async function handleUpgrade(request, socket, head, route) {
    socket.pause();
    let backendRequest;
    let backendResponse;
    let backendSocket;
    let releaseTarget = () => undefined;
    const cancelUpstream = () => {
      backendResponse?.destroy();
      backendSocket?.destroy();
      backendRequest?.destroy();
      releaseTarget();
    };
    socket.once("close", cancelUpstream);
    if (route.kind !== "game") {
      sendSocketResponse(
        socket,
        route.kind === "invalid" ? 400 : 404,
        route.kind === "invalid" ? "Bad Request" : "Not Found",
        JSON.stringify({ error: route.kind === "invalid" ? "INVALID_GAME_ROUTE" : "NOT_FOUND" }),
      );
      return;
    }

    let target;
    try {
      target = await resolveTarget(route);
    } catch {
      sendSocketResponse(socket, 500, "Internal Server Error", JSON.stringify({ error: "INTERNAL_ERROR" }));
      return;
    }
    if (target.kind === "not-found") {
      sendSocketResponse(socket, 404, "Not Found", JSON.stringify({ error: "NOT_FOUND" }));
      return;
    }
    if (target.kind === "unavailable") {
      sendSocketResponse(socket, 503, "Service Unavailable", JSON.stringify({ error: "GAME_UNAVAILABLE" }));
      return;
    }
    if (socket.destroyed) {
      target.runtime.release();
      return;
    }
    releaseTarget = target.runtime.release;

    try {
      backendRequest = httpRequest({
        host: target.runtime.host,
        port: target.runtime.port,
        method: request.method,
        path: route.backendPath,
        headers: proxyRequestHeaders(request.headers, true),
      });
    } catch {
      releaseTarget();
      sendSocketResponse(socket, 400, "Bad Request", JSON.stringify({ error: "INVALID_GAME_ROUTE" }));
      return;
    }

    backendRequest.once("socket", (backendConnection) => {
      if (backendConnection.connecting) {
        backendConnection.once("connect", releaseTarget);
      } else {
        queueMicrotask(releaseTarget);
      }
      backendConnection.once("error", releaseTarget);
    });

    backendRequest.once("upgrade", (upgradeResponse, upgradeSocket, backendHead) => {
      backendResponse = upgradeResponse;
      backendSocket = upgradeSocket;
      if (socket.destroyed) {
        cancelUpstream();
        return;
      }
      writeUpgradeHead(socket, backendResponse);
      if (head.length > 0) {
        backendSocket.write(head);
      }
      if (backendHead.length > 0) {
        socket.write(backendHead);
      }
      socket.pipe(backendSocket);
      backendSocket.pipe(socket);
      socket.once("error", () => backendSocket.destroy());
      backendSocket.once("error", () => socket.destroy());
      socket.resume();
      backendSocket.resume();
    });
    backendRequest.once("response", (incomingResponse) => {
      backendResponse = incomingResponse;
      if (socket.destroyed) {
        backendResponse.destroy();
        return;
      }
      const status = backendResponse.statusCode ?? 502;
      const reason = backendResponse.statusMessage ?? "Bad Gateway";
      const headers = proxyResponseHeaders(backendResponse.headers);
      const lines = [`HTTP/1.1 ${status} ${reason}`];
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          lines.push(`${name}: ${item}`);
        }
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      backendResponse.pipe(socket);
      backendResponse.once("end", () => socket.end());
      const destroySocket = () => {
        if (!socket.destroyed) {
          socket.destroy();
        }
      };
      backendResponse.once("aborted", destroySocket);
      backendResponse.once("error", destroySocket);
      backendResponse.once("close", () => {
        if (!backendResponse.complete) {
          destroySocket();
        }
      });
      socket.resume();
    });
    backendRequest.once("error", () => {
      releaseTarget();
      if (!socket.destroyed) {
        sendSocketResponse(socket, 502, "Bad Gateway", JSON.stringify({ error: "GAME_UNAVAILABLE" }));
      }
    });
    if (socket.destroyed) {
      releaseTarget();
      backendRequest.destroy();
      return;
    }
    backendRequest.end();
  }

  return Object.freeze({ handleHttp, handleUpgrade });
}
