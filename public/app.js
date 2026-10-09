const gamesRoot = document.querySelector("#games");
const tableRoot = document.querySelector("#table");
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
// Fixed tilt per library slot, so the loose scatter of boxes is stable across renders.
const TILT = [
  { r: -3.6, x: 2, y: -4 }, { r: 2.8, x: -3, y: 3 }, { r: -1.2, x: 4, y: 6 },
  { r: 4.6, x: -2, y: -2 }, { r: -4.8, x: 3, y: 4 }, { r: 1.9, x: -4, y: -6 },
];
// QR codes printed in the table's colours: walnut modules and felt-green finder squares on cream card.
const QR_THEME = { quietZone: 3, dark: "#2b1a0e", finder: "#234a3f", light: "#fbf5e8" };
const MEEPLE = '<svg viewBox="0 0 24 32"><circle cx="12" cy="7" r="5.5"/><path d="M6 14.5h12c0 4-1.6 6.2-2.8 8.2 2.2 1 3.8 3 3.8 6.3H5c0-3.3 1.6-5.3 3.8-6.3C7.6 20.7 6 18.5 6 14.5z"/></svg>';
let library = { games: [], runtime: null, busy: false };
let pending = null;
let unavailable = false;
let lastRender = "";
let refreshSequence = 0;
let refreshInFlight = null;
// QR ticket (`<gameId>:play|board`) whose link was just copied; it shows a stamp briefly.
let copied = null;
let copiedTimer = null;

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

// Decorative table pieces: hidden from assistive technology, positioned by CSS.
function piece(tag, className, style) {
  const element = document.createElement(tag);
  element.className = className;
  element.setAttribute("aria-hidden", "true");
  if (style) element.setAttribute("style", style);
  return element;
}

function actionButton(text, gameId, operation, disabled) {
  const button = textElement("button", operation === "stop" ? "token wood" : "token brass", text);
  button.type = "button";
  button.dataset.focusKey = `${gameId}:${operation}`;
  button.disabled = disabled;
  button.addEventListener("click", () => void runAction(gameId, operation));
  return button;
}

function gameLink(text, path, key, style) {
  const link = textElement("a", `token ${style}`, text);
  link.href = new URL(path, window.location.origin).href;
  link.dataset.focusKey = key;
  return link;
}

// Box colours step round the colour wheel by the golden angle in library order, so neighbours never match.
function hueOf(game) {
  return Math.round((18 + 137.5 * Math.max(0, library.games.indexOf(game))) % 360);
}

function playerRange({ min, max }) {
  return min === max ? `${min}` : `${min}–${max}`;
}

function gameMeta(game) {
  return `${playerRange(game.players)} players · ${game.capabilities?.dedicatedDisplay ? "board display too" : "phones only"}`;
}

function hueStyle(game) {
  const hue = hueOf(game);
  return `--hue:${hue};--hue2:${(hue + 24) % 360}`;
}

// Generated box art until games can supply distributable artwork.
function cover(game, title) {
  const art = document.createElement("div");
  art.className = "cover";
  art.setAttribute("style", hueStyle(game));
  const band = document.createElement("span");
  band.className = "band";
  band.append(title, textElement("small", "", `${playerRange(game.players)} players`));
  const glyph = textElement("span", "glyph", [...game.name.trim()][0]?.toUpperCase() ?? "?");
  glyph.setAttribute("aria-hidden", "true");
  art.append(glyph, band);
  return art;
}

function controls(game, locked) {
  const isActive = library.runtime?.gameId === game.id;
  const cleanupRequired = library.runtime?.status === "failed";
  const buttons = [];
  if (isActive) buttons.push(actionButton("Stop game", game.id, "stop", locked));
  if (!isActive || (game.status === "running" && !game.playUrl)) {
    buttons.push(actionButton(
      library.runtime ? (isActive ? "Restart game" : "Switch to this game") : "Start game",
      game.id, "start", locked || cleanupRequired,
    ));
  }
  return buttons;
}

// Copies inside the click itself. Plain-HTTP LAN addresses are not secure contexts, so the
// async clipboard API is often absent there, and elsewhere it may wait on a permission prompt.
function copyBySelection(text) {
  const previous = document.activeElement;
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "visually-hidden";
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const done = document.execCommand("copy");
    area.remove();
    return done;
  } catch {
    return false;
  } finally {
    previous?.focus?.();
  }
}

async function copyText(text) {
  if (copyBySelection(text)) return true;
  try {
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((resolve, reject) => { setTimeout(() => reject(new Error("Clipboard timed out")), 2_000); }),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function copyLink(key, href, label) {
  if (!await copyText(href)) {
    feedbackRoot.textContent = "This browser blocked copying. Scan the code instead, or open the game and share its address.";
    return;
  }
  feedbackRoot.textContent = `The ${label} link was copied. Paste it to anyone on this network.`;
  copied = key;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copied = null; render(); }, 1_600);
  render();
}

function qrTicket(label, href, key) {
  let source;
  try {
    source = globalThis.nexusQr.toDataUrl(href, QR_THEME);
  } catch {
    return textElement("p", "qr-unavailable", `The ${label} link is too long to print as a QR code. Use the Open button instead.`);
  }
  const board = label !== "game";
  const ticket = document.createElement("button");
  ticket.type = "button";
  ticket.className = `qr-ticket${board ? " board" : ""}${copied === key ? " copied" : ""}`;
  ticket.dataset.focusKey = `${key}-qr`;
  ticket.setAttribute("aria-label", `QR code for the ${label} link. Press to copy the link so you can share it.`);
  const image = document.createElement("img");
  image.className = "qr-code";
  image.src = source;
  image.alt = "";
  image.width = 240;
  image.height = 240;
  const stamp = textElement("span", "qr-stamp", "Link copied");
  stamp.setAttribute("aria-hidden", "true");
  ticket.append(textElement("span", "qr-k", board ? "Board display" : "Scan to join"), image,
    textElement("span", "qr-hint", "tap to copy the link"), stamp);
  ticket.addEventListener("click", () => void copyLink(key, href, label));
  return ticket;
}

function isLoopback(href) {
  const host = new URL(href).hostname;
  return ["localhost", "127.0.0.1", "[::1]"].includes(host) || host.endsWith(".localhost");
}

function openBox(game, phase) {
  const box = document.createElement("div");
  box.className = "opened";
  box.setAttribute("style", hueStyle(game));
  const tray = piece("div", "tray");
  tray.append(
    piece("span", "die d3 tok", "--i:0"), piece("span", "die d5 tok", "--i:1"),
    piece("span", "cube q1 tok", "--i:2"), piece("span", "cube q2 tok", "--i:3"),
  );
  for (const [className, index] of [["m1", 4], ["m2", 5]]) {
    const meeple = piece("span", `meeple ${className} tok`, `--i:${index}`);
    meeple.innerHTML = MEEPLE;
    tray.append(meeple);
  }
  const lid = piece("div", "lid-leaning");
  lid.append(cover(game, textElement("b", "", game.name)));
  const fan = piece("div", "fan");
  fan.append(piece("span", "card back k1 tok", "--i:6"), piece("span", "card back k2 tok", "--i:7"));
  const face = piece("span", "card face k3 tok", "--i:8");
  face.textContent = [...game.name.trim()][0]?.toUpperCase() ?? "?";
  fan.append(face);
  box.append(tray, lid, fan);
  if (phase === "failed") {
    const torn = document.createElement("div");
    torn.className = "torn-wrap";
    const note = document.createElement("div");
    note.className = "torn";
    note.append(textElement("p", "torn-title", "Didn’t start"),
      textElement("p", "torn-text", game.message ?? "Check the Nexus host console for details."));
    torn.append(note);
    box.append(torn, piece("span", "xtok"));
  } else if (game.description) {
    const booklet = document.createElement("div");
    booklet.className = "booklet";
    booklet.append(textElement("p", "bk-title", "Rulebook"), textElement("p", "bk-text", game.description));
    box.append(booklet);
  }
  return box;
}

function dropZone() {
  const zone = document.createElement("div");
  zone.className = "play empty";
  const inner = document.createElement("div");
  inner.className = "drop";
  const arrow = piece("span", "arrow");
  arrow.innerHTML = '<svg viewBox="0 0 120 80"><path d="M10 12C48 4 96 22 104 62"/><path d="M90 50 104 64 112 48"/></svg>';
  inner.append(textElement("b", "", "Nothing on the table"),
    textElement("p", "", "Press Start game on a box in the library below and it lands here, ready to play."), arrow);
  zone.append(inner);
  return zone;
}

// The game on the table: the active runtime's game, or else one whose start just failed.
function tableGame() {
  return library.games.find((game) => game.id === library.runtime?.gameId)
    ?? library.games.find((game) => game.id === pending?.gameId && pending.operation === "start")
    ?? library.games.find((game) => game.status === "failed")
    ?? null;
}

function renderTable(game, locked) {
  if (game === null) {
    tableRoot.replaceChildren(dropZone());
    return;
  }
  const phase = pending?.gameId === game.id ? (pending.operation === "start" ? "starting" : "stopping") : game.status;
  const play = document.createElement("div");
  play.className = `play ${phase}`;
  play.append(openBox(game, phase));

  const pad = document.createElement("aside");
  pad.className = "pad";
  pad.setAttribute("aria-label", "Score pad");
  const title = textElement("h2", "pad-title", game.name);
  title.tabIndex = -1;
  title.dataset.focusKey = `${game.id}:title`;
  const lamp = textElement("p", `lamp ${phase}`, "");
  lamp.setAttribute("role", "status");
  lamp.append(piece("i", ""), textElement("span", "", labels[phase] ?? phase));
  pad.append(textElement("p", "pad-kicker", "Score pad"), title, lamp, textElement("p", "meta", gameMeta(game)));
  if (game.message && phase !== "failed") pad.append(textElement("p", "pad-note bad", game.message));

  const actions = document.createElement("div");
  actions.className = "pad-acts";
  if (game.playUrl && !locked) {
    const links = [["game", "Open game", game.playUrl, "play", "brass"]];
    if (game.boardUrl) links.push(["board display", "Open board display", game.boardUrl, "board", "paper"]);
    for (const [label, text, path, kind, style] of links) {
      const link = gameLink(text, path, `${game.id}:${kind}`, style);
      actions.append(link);
      if (globalThis.nexusQr) pad.append(qrTicket(label, link.href, `${game.id}:${kind}`));
    }
    if (globalThis.nexusQr && isLoopback(new URL(game.playUrl, window.location.origin).href)) {
      pad.append(textElement("p", "pad-note bad",
        "This portal was opened through a local-only address, so other devices cannot use these codes. Open the portal at the host's LAN address instead."));
    }
  }
  actions.append(...controls(game, locked));
  pad.append(actions);
  tableRoot.replaceChildren(play, pad);
}

function librarySlot(game, index, locked) {
  const slot = document.createElement("li");
  slot.className = "slot";
  const tilt = TILT[index % TILT.length];
  slot.setAttribute("style", `--r:${tilt.r}deg;--dx:${tilt.x}px;--dy:${tilt.y}px`);
  const title = textElement("h3", "", game.name);
  title.tabIndex = -1;
  title.dataset.focusKey = `${game.id}:title`;
  const lid = document.createElement("div");
  lid.className = "lid";
  lid.append(cover(game, title));
  const tag = document.createElement("div");
  tag.className = "tag";
  tag.append(textElement("span", "info", gameMeta(game)));
  if (game.description) tag.append(textElement("span", "visually-hidden", game.description));
  if (game.message) tag.append(textElement("span", "state", game.message));
  tag.append(...controls(game, locked));
  slot.append(lid, tag);
  return slot;
}

function gapSlot() {
  const slot = document.createElement("li");
  slot.className = "slot";
  slot.append(textElement("div", "gap-box", "Out on the table"));
  return slot;
}

function banner(text, bad) {
  return textElement("p", bad ? "banner bad" : "banner", text);
}

function render() {
  const signature = JSON.stringify({ library, pending, unavailable, copied });
  // Leave focused controls in place on unchanged polling responses.
  if (signature === lastRender) return;
  lastRender = signature;
  const focusKey = document.activeElement?.dataset.focusKey;
  const locked = unavailable || pending !== null || library.busy;
  const onTable = tableGame();
  renderTable(onTable, locked);
  gamesRoot.replaceChildren(...library.games.map((game, index) =>
    game.id === onTable?.id ? gapSlot() : librarySlot(game, index, locked)));
  if (library.games.length === 0) {
    gamesRoot.append(textElement("li", "empty-state", unavailable
      ? "The game library could not be loaded. Check the Nexus host and refresh to retry."
      : "No games are configured yet. Add game paths on the Nexus host, then refresh."));
  }
  statusRoot.textContent = unavailable ? "Connection lost · Controls paused"
    : `${library.games.length} ${library.games.length === 1 ? "box" : "boxes"} in the library${locked ? " · Updating…" : ""}`;
  runtimeRoot.replaceChildren();
  if (unavailable) {
    const note = banner("The line to the Nexus host dropped, so controls are paused.", true);
    if (library.runtime) note.append(actionButton("Retry stop active game", library.runtime.gameId, "stop", pending !== null));
    runtimeRoot.append(note);
  }
  if (library.runtime?.status === "failed") {
    runtimeRoot.append(banner(
      "Cleanup is unresolved. Retry Stop game; check the Nexus host console if it keeps failing. Starting another game is paused.", true));
  }
  if (library.runtime && !library.games.some((game) => game.id === library.runtime.gameId)) {
    const note = banner("A game removed from this library still has an active runtime.", false);
    note.append(actionButton("Stop active game", library.runtime.gameId, "stop", locked));
    runtimeRoot.append(note);
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
