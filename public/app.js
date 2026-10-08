const gamesRoot = document.querySelector("#games");
const statusRoot = document.querySelector("#library-status");
const runtimeRoot = document.querySelector("#runtime-status");
const feedbackRoot = document.querySelector("#action-feedback");
const dialog = document.querySelector("#confirm-action");
const refreshButton = document.querySelector("#refresh-library");

const labels = {
  configured: "Stopped · Ready to start", starting: "Starting…", running: "Running",
  stopping: "Stopping…", stopped: "Stopped", failed: "Failed",
};
const errors = {
  ACTION_FORBIDDEN: "This action was refused. Open the portal directly from the Nexus address and try again.",
  GAME_NOT_FOUND: "This game is no longer in the library. Refresh and choose another game.",
  LIFECYCLE_BUSY: "Another game action is in progress. Wait for its status to update.",
  RUNTIME_CHANGED: "The active game changed. Review its current status and try again.",
  LIFECYCLE_FAILED: "The game action failed. Review its status below; further details are in the Nexus host console.",
};
let library = { games: [], runtime: null, busy: false };
let pending = null;
let unavailable = false;
let lastRender = "";
let refreshSequence = 0;
let refreshInFlight = null;
// Links whose QR code the host has expanded; keys are `<gameId>:play|board`.
const shownQr = new Set();

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function actionButton(text, gameId, operation, disabled) {
  const button = textElement("button", operation === "stop" ? "secondary" : "", text);
  button.type = "button";
  button.dataset.focusKey = `${gameId}:${operation}`;
  button.disabled = disabled;
  button.addEventListener("click", () => void runAction(gameId, operation));
  return button;
}

function gameLink(text, path, key) {
  const link = textElement("a", "game-link", text);
  link.href = new URL(path, window.location.origin).href;
  link.dataset.focusKey = key;
  return link;
}

function qrToggle(label, key) {
  const shown = shownQr.has(key);
  const button = textElement("button", "secondary", shown ? `Hide ${label} QR` : `Show ${label} QR`);
  button.type = "button";
  button.dataset.focusKey = `${key}-qr`;
  button.setAttribute("aria-expanded", String(shown));
  button.addEventListener("click", () => {
    if (shownQr.has(key)) shownQr.delete(key); else shownQr.add(key);
    render();
  });
  return button;
}

function qrPanel(label, href) {
  const panel = document.createElement("figure");
  panel.className = "qr-panel";
  let source = "";
  try {
    source = globalThis.nexusQr.toDataUrl(href);
  } catch {
    panel.append(textElement("p", "error-state", "This link is too long to show as a QR code. Use the link directly."));
    return panel;
  }
  const image = document.createElement("img");
  image.className = "qr-code";
  image.src = source;
  image.alt = `QR code for the ${label} link`;
  image.width = 220;
  image.height = 220;
  panel.append(image, textElement("figcaption", "qr-caption", href));
  const host = new URL(href).hostname;
  if (["localhost", "127.0.0.1", "[::1]"].includes(host) || host.endsWith(".localhost")) {
    panel.append(textElement("p", "host-note",
      "This portal was opened through a local-only address, so other devices cannot use this code. Open the portal at the host's LAN address, then show the QR code."));
  }
  return panel;
}

function renderGame(game, locked) {
  const card = document.createElement("article");
  card.className = "game-card";
  const title = textElement("h3", "game-title", game.name);
  title.tabIndex = -1;
  title.dataset.focusKey = `${game.id}:title`;
  card.append(title);
  if (game.description) card.append(textElement("p", "game-description", game.description));
  card.append(textElement("p", "game-meta", `${game.players.min}–${game.players.max} players · TV-less`));
  const status = textElement("span", `status-pill status-${game.status}`, labels[game.status] ?? game.status);
  status.setAttribute("role", "status");
  card.append(status);
  if (game.message) card.append(textElement("p", "error-state", game.message));
  const actions = document.createElement("div");
  actions.className = "actions";
  const isActive = library.runtime?.gameId === game.id;
  const cleanupRequired = library.runtime?.status === "failed";
  if (isActive) actions.append(actionButton("Stop game", game.id, "stop", locked));
  if (!isActive || (game.status === "running" && !game.playUrl)) {
    actions.append(actionButton(
      library.runtime ? (isActive ? "Restart game" : "Switch to this game") : "Start game",
      game.id, "start", locked || cleanupRequired,
    ));
  }
  const panels = [];
  if (game.playUrl && !locked) {
    const links = [["game", "Open game", game.playUrl, "play"]];
    if (game.boardUrl) links.push(["board display", "Open board display", game.boardUrl, "board"]);
    for (const [label, text, path, kind] of links) {
      const link = gameLink(text, path, `${game.id}:${kind}`);
      actions.append(link);
      if (!globalThis.nexusQr) continue;
      actions.append(qrToggle(label, `${game.id}:${kind}`));
      if (shownQr.has(`${game.id}:${kind}`)) panels.push(qrPanel(label, link.href));
    }
  }
  card.append(actions, ...panels);
  return card;
}

function render() {
  const signature = JSON.stringify({ library, pending, unavailable, shownQr: [...shownQr] });
  // Leave focused controls in place on unchanged polling responses.
  if (signature === lastRender) return;
  lastRender = signature;
  const focusKey = document.activeElement?.dataset.focusKey;
  const locked = unavailable || pending !== null || library.busy;
  gamesRoot.replaceChildren(...library.games.map((game) => renderGame(game, locked)));
  if (library.games.length === 0) {
    gamesRoot.append(textElement("p", "empty-state", unavailable
      ? "The game library could not be loaded. Check the Nexus host and refresh to retry."
      : "No games are configured yet. Add game paths on the Nexus host, then refresh."));
  }
  statusRoot.textContent = unavailable ? "Connection lost · Controls paused"
    : `${library.games.length} configured${locked ? " · Updating…" : ""}`;
  runtimeRoot.replaceChildren();
  if (library.runtime?.status === "failed") {
    runtimeRoot.append(textElement("p", "error-state",
      "Cleanup is unresolved. Retry Stop game; check the Nexus host console if it keeps failing. Starting another game is paused."));
  }
  if (library.runtime && !library.games.some((game) => game.id === library.runtime.gameId)) {
    runtimeRoot.append(textElement("p", "host-note", "A game removed from this library still has an active runtime."));
    runtimeRoot.append(actionButton("Stop active game", library.runtime.gameId, "stop", locked));
  }
  if (unavailable && library.runtime) {
    runtimeRoot.append(actionButton("Retry stop active game", library.runtime.gameId, "stop", pending !== null));
  }
  if (focusKey) {
    const controls = [...document.querySelectorAll("[data-focus-key]")];
    const matching = controls.find((node) => node.dataset.focusKey === focusKey && !node.disabled);
    const title = controls.find((node) => node.dataset.focusKey === `${focusKey.split(":")[0]}:title`);
    (matching ?? title ?? refreshButton).focus();
  }
}

function refresh() {
  if (refreshInFlight !== null) return refreshInFlight;
  refreshInFlight = loadLibrary().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function loadLibrary() {
  const sequence = ++refreshSequence;
  try {
    const response = await fetch("/api/games", { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("Library unavailable");
    const result = await response.json();
    if (sequence !== refreshSequence) return;
    library = result;
    unavailable = false;
  } catch {
    if (sequence !== refreshSequence) return;
    unavailable = true;
  }
  render();
}

function confirmEndSession(gameId, operation) {
  const current = library.games.find((game) => game.id === library.runtime?.gameId)?.name ?? "the active game";
  const next = library.games.find((game) => game.id === gameId)?.name ?? "this game";
  document.querySelector("#confirm-description").textContent = operation === "stop"
    ? `Stopping ${current} ends its current session for all players.`
    : `Starting ${next} stops ${current} and ends its current session for all players.`;
  return new Promise((resolve) => {
    const cancel = document.querySelector("#cancel-action");
    const proceed = document.querySelector("#continue-action");
    const finish = (accepted) => {
      cancel.removeEventListener("click", onCancel);
      proceed.removeEventListener("click", onContinue);
      dialog.removeEventListener("cancel", onEscape);
      dialog.close();
      resolve(accepted);
    };
    const onCancel = () => finish(false);
    const onContinue = () => finish(true);
    const onEscape = (event) => { event.preventDefault(); finish(false); };
    cancel.addEventListener("click", onCancel);
    proceed.addEventListener("click", onContinue);
    dialog.addEventListener("cancel", onEscape);
    dialog.showModal();
  });
}

async function runAction(gameId, operation) {
  if (pending !== null || dialog.open) return;
  // Keep the runtime whose session the host agreed to end, even if another tab
  // changes it during confirmation. The server then rejects the stale action.
  const activeGameId = library.runtime?.gameId ?? "";
  if (activeGameId && !await confirmEndSession(gameId, operation)) return;
  pending = { gameId, operation };
  // Discard any response captured before this mutation began.
  refreshSequence += 1;
  feedbackRoot.textContent = operation === "start" ? "Starting game…" : "Stopping game…";
  render();
  try {
    const response = await fetch(`/api/games/${gameId}/${operation}`, {
      method: "POST",
      headers: { "x-nexus-action": "1", "x-nexus-active-game": activeGameId },
      signal: AbortSignal.timeout(45_000),
    });
    const result = await response.json();
    feedbackRoot.textContent = response.ok
      ? (operation === "start" ? "Game ready. Choose Open game to play." : "Game stopped.")
      : (errors[result.error] ?? "The action could not be completed. Refresh its status and try again.");
  } catch {
    feedbackRoot.textContent = "The connection was interrupted. Review the current status before trying again.";
  } finally {
    pending = null;
    refreshSequence += 1;
    // Let a pre-completion poll finish, then request the definitive state.
    if (refreshInFlight !== null) await refreshInFlight;
    await refresh();
  }
}

refreshButton.addEventListener("click", () => void refresh());
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 1_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
