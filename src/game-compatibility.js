import { parsePublicGameRoute } from "./game-proxy.js";

function isSuccessful(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function assertGame(game) {
  const manifest = game?.manifest;
  if (typeof manifest?.id !== "string"
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id)) {
    throw new TypeError("game.manifest.id must be a lowercase kebab-case identifier");
  }
  if (manifest.capabilities === null || Array.isArray(manifest.capabilities)
    || typeof manifest.capabilities !== "object") {
    throw new TypeError("game.manifest.capabilities must be an object");
  }
  if (manifest.capabilities.tvLess !== true) {
    throw new TypeError("game.manifest.capabilities.tvLess must be true");
  }
  if (manifest.capabilities.dedicatedDisplay !== undefined
    && typeof manifest.capabilities.dedicatedDisplay !== "boolean") {
    throw new TypeError("game.manifest.capabilities.dedicatedDisplay must be boolean when present");
  }
  return manifest;
}

function isInsideGameBase(url, origin, basePath) {
  return url.origin === origin
    && (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`));
}

async function followPublicRoute({ fetchImpl, origin, basePath, route, label, requestTimeoutMs }) {
  let url = new URL(route, origin);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    // This is a status/route check. Release even an endless response body so
    // checking a landing or redirect cannot leave a game connection open.
    await response.body?.cancel();
    if (isSuccessful(response.status)) {
      return { url: url.toString(), status: response.status };
    }
    if (!isRedirect(response.status)) {
      throw new Error(`${label} returned HTTP ${response.status}`);
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`${label} redirected without a Location header`);
    }
    let next;
    try {
      next = new URL(location, url);
    } catch {
      throw new Error(`${label} redirected to an invalid URL`);
    }
    if (!isInsideGameBase(next, origin, basePath)) {
      throw new Error(`${label} redirected outside its public same-origin base path`);
    }
    if (next.username || next.password
      || parsePublicGameRoute(`${next.pathname}${next.search}`).kind !== "game") {
      throw new Error(`${label} redirected to an invalid or reserved public game route`);
    }
    url = next;
  }
  throw new Error(`${label} exceeded the redirect limit`);
}

/**
 * Check public route availability and redirect containment without interpreting
 * page contents or a game's rules/protocol. Call against a Nexus public origin
 * after the selected game is running. Injected fetch implementations must honor
 * the request's AbortSignal.
 */
export async function verifyPublicGameCompatibility({
  origin, game, fetchImpl = fetch, requestTimeoutMs = 5_000,
}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2_147_483_647) {
    throw new TypeError("requestTimeoutMs must be a positive timer-sized integer");
  }
  const originUrl = new URL(origin);
  if (!["http:", "https:"].includes(originUrl.protocol) || originUrl.username || originUrl.password) {
    throw new TypeError("origin must be an HTTP(S) URL without credentials");
  }
  const publicOrigin = originUrl.origin;
  const manifest = assertGame(game);
  const basePath = `/games/${manifest.id}`;
  const result = {
    playerLanding: await followPublicRoute({
      fetchImpl,
      origin: publicOrigin,
      basePath,
      route: `${basePath}/`,
      label: "player landing page",
      requestTimeoutMs,
    }),
  };

  if (manifest.capabilities.dedicatedDisplay === true) {
    result.dedicatedDisplay = await followPublicRoute({
      fetchImpl,
      origin: publicOrigin,
      basePath,
      route: `${basePath}/board/`,
      label: "dedicated display entrypoint",
      requestTimeoutMs,
    });
  }
  return Object.freeze(result);
}
