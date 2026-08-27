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
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
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

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return { kind: "invalid" };
  }

  // A remaining percent sign represents nested encoding. Backslashes,
  // controls, duplicate separators, and dot segments have differing path
  // meanings across common backend routers, so none cross the proxy boundary.
  if (
    decodedPath.includes("%")
    || decodedPath.includes("\\")
    || decodedPath.includes("//")
    || /[\u0000-\u001f\u007f]/u.test(decodedPath)
  ) {
    return { kind: "invalid" };
  }

  const trailingSlash = decodedPath.endsWith("/");
  const segments = decodedPath.split("/");
  if (
    segments[0] !== ""
    || segments[1] !== "games"
    || !GAME_ID_PATTERN.test(segments[2] ?? "")
  ) {
    return { kind: "invalid" };
  }

  const gameSegments = segments.slice(3);
  if (trailingSlash) {
    gameSegments.pop();
  }
  if (gameSegments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return { kind: "invalid" };
  }
  if (gameSegments[0] !== undefined && asciiEqualsIgnoreCase(gameSegments[0], "__nexus")) {
    return { kind: "reserved" };
  }

  return {
    kind: "game",
    gameId: segments[2],
    backendPath: `${encodePath(gameSegments, trailingSlash)}${query}`,
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
  if (!supervisor || typeof supervisor.getActiveRuntime !== "function") {
    throw new TypeError("supervisor.getActiveRuntime must be a function");
  }

  async function resolveTarget(route) {
    const library = await loadLibrary(configPath);
    if (!library.some((game) => game.manifest.id === route.gameId)) {
      return { kind: "not-found" };
    }
    const runtime = supervisor.getActiveRuntime();
    if (
      runtime === null
      || runtime.gameId !== route.gameId
      || runtime.status !== "running"
    ) {
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

    const target = await resolveTarget(route);
    if (target.kind === "not-found") {
      sendJson(response, 404, { error: "NOT_FOUND" }, request.method);
      return;
    }
    if (target.kind === "unavailable") {
      sendJson(response, 503, { error: "GAME_UNAVAILABLE" }, request.method);
      return;
    }

    let backendRequest;
    try {
      backendRequest = httpRequest({
        host: target.runtime.host,
        port: target.runtime.port,
        method: request.method,
        path: route.backendPath,
        headers: proxyRequestHeaders(request.headers, false),
      });
    } catch {
      sendJson(response, 400, { error: "INVALID_GAME_ROUTE" }, request.method);
      return;
    }

    backendRequest.once("response", (backendResponse) => {
      response.writeHead(
        backendResponse.statusCode ?? 502,
        proxyResponseHeaders(backendResponse.headers),
      );
      backendResponse.pipe(response);
      response.once("close", () => backendResponse.destroy());
    });
    backendRequest.once("error", () => {
      if (!response.headersSent) {
        sendJson(response, 502, { error: "GAME_UNAVAILABLE" }, request.method);
      } else {
        response.destroy();
      }
    });
    request.once("aborted", () => backendRequest.destroy());
    request.pipe(backendRequest);
  }

  async function handleUpgrade(request, socket, head, route) {
    socket.pause();
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
      return;
    }

    let backendRequest;
    try {
      backendRequest = httpRequest({
        host: target.runtime.host,
        port: target.runtime.port,
        method: request.method,
        path: route.backendPath,
        headers: proxyRequestHeaders(request.headers, true),
      });
    } catch {
      sendSocketResponse(socket, 400, "Bad Request", JSON.stringify({ error: "INVALID_GAME_ROUTE" }));
      return;
    }

    backendRequest.once("upgrade", (backendResponse, backendSocket, backendHead) => {
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
    backendRequest.once("response", (backendResponse) => {
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
      socket.resume();
    });
    backendRequest.once("error", () => {
      sendSocketResponse(socket, 502, "Bad Gateway", JSON.stringify({ error: "GAME_UNAVAILABLE" }));
    });
    socket.once("close", () => backendRequest.destroy());
    backendRequest.end();
  }

  return Object.freeze({ handleHttp, handleUpgrade });
}
