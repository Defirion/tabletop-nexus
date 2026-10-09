(() => {
// Shared mock behaviour for the four Tabletop Nexus art-direction studies.
// It mirrors the rules in public/app.js (one runtime at a time, confirm before ending a
// session, failed cleanup blocks switching, controls lock while an action is pending)
// so every study shows the SAME functionality in a different skin. Mock data only.

const ORIGIN = "http://192.168.1.24:8080";

const GAMES = [
  { id: "cinder-court", name: "Cinder Court", description: "Trade favours and betray allies in a smouldering royal court.", players: { min: 2, max: 4 }, boardUrl: true, mins: 60, tag: "Intrigue", hue: 18 },
  { id: "salt-and-sail", name: "Salt & Sail", description: "Race tall ships across a shifting chart, hauling cargo between ports.", players: { min: 3, max: 5 }, boardUrl: true, mins: 45, tag: "Racing", hue: 200 },
  { id: "lanternfall", name: "Lanternfall", description: "A cooperative night-garden puzzle. Light every lantern before dawn.", players: { min: 1, max: 4 }, boardUrl: false, mins: 30, tag: "Co-op", hue: 48 },
  { id: "hex-harvest", name: "Hex Harvest", description: "Tile-laying farm builder with a very polite amount of sabotage.", players: { min: 2, max: 6 }, boardUrl: true, mins: 50, tag: "Builder", hue: 128 },
  { id: "trick-tavern", name: "Trick Tavern", description: "A fast, loud trick-taking card game for a full table.", players: { min: 3, max: 7 }, boardUrl: false, mins: 20, tag: "Cards", hue: 335 },
  { id: "orbit-heist", name: "Orbit Heist", description: "Hidden-role space robbery. Someone on the crew is not who they say.", players: { min: 4, max: 8 }, boardUrl: true, mins: 35, tag: "Hidden role", hue: 268, failsToStart: true },
];

const labels = {
  configured: "Ready to start", starting: "Starting…", running: "Running",
  stopping: "Stopping…", stopped: "Stopped", failed: "Failed",
};
const statusLabel = (s) => labels[s] ?? s;

const FAIL_MESSAGE = "The game could not run. Try starting it again; if it still fails, check its setup on the Nexus host.";

const state = {
  runtime: null,            // { gameId, status }
  pending: null,            // { gameId, operation }
  unavailable: false,
  feedback: "",
  orphan: false,            // active runtime whose game was removed from the library
  startedAt: null,
};
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn(getView()));
const subscribe = (fn) => { listeners.add(fn); fn(getView()); };

function getView() {
  const locked = state.unavailable || state.pending !== null;
  const cleanupRequired = state.runtime?.status === "failed";
  const games = GAMES.map((game) => {
    const isActive = state.runtime?.gameId === game.id;
    const status = isActive ? state.runtime.status : "configured";
    const playable = isActive && status === "running";
    return {
      ...game,
      isActive,
      status,
      label: statusLabel(status),
      message: status === "failed" ? FAIL_MESSAGE : "",
      canStop: isActive,
      stopDisabled: locked,
      showStart: !isActive,
      startLabel: state.runtime ? (isActive ? "Restart game" : "Switch to this game") : "Start game",
      startDisabled: locked || cleanupRequired,
      canOpen: playable && !locked,
      playUrl: `${ORIGIN}/g/${game.id}/`,
      boardUrl: game.boardUrl ? `${ORIGIN}/g/${game.id}/board/` : null,
    };
  });
  return {
    games, locked, cleanupRequired,
    runtime: state.runtime,
    active: games.find((g) => g.isActive) ?? null,
    pending: state.pending,
    unavailable: state.unavailable,
    feedback: state.feedback,
    orphan: state.orphan,
    startedAt: state.startedAt,
    count: GAMES.length,
  };
}

// ---- confirm dialog (markup supplied by each study: #confirm, #confirm-title, #confirm-text, #confirm-cancel, #confirm-ok)
function confirmEnd(gameId, operation) {
  const dialog = document.querySelector("#confirm");
  const current = GAMES.find((g) => g.id === state.runtime?.gameId)?.name ?? "the active game";
  const next = GAMES.find((g) => g.id === gameId)?.name ?? "this game";
  document.querySelector("#confirm-text").textContent = operation === "stop"
    ? `Stopping ${current} ends its current session for all players.`
    : `Starting ${next} stops ${current} and ends its current session for all players.`;
  return new Promise((resolve) => {
    const cancel = document.querySelector("#confirm-cancel");
    const ok = document.querySelector("#confirm-ok");
    const done = (v) => { cancel.onclick = ok.onclick = null; dialog.close(); resolve(v); };
    cancel.onclick = () => done(false);
    ok.onclick = () => done(true);
    dialog.oncancel = (e) => { e.preventDefault(); done(false); };
    dialog.showModal();
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function act(gameId, operation) {
  if (state.pending || document.querySelector("#confirm")?.open) return;
  if (state.runtime && !(await confirmEnd(gameId, operation))) return;
  const game = GAMES.find((g) => g.id === gameId);
  state.pending = { gameId, operation };
  state.feedback = operation === "start" ? "Starting game…" : "Stopping game…";
  if (operation === "stop") {
    state.runtime = { gameId: state.runtime?.gameId ?? gameId, status: "stopping" };
    emit(); await wait(900);
    state.runtime = null; state.orphan = false; state.startedAt = null;
    state.feedback = "Game stopped.";
  } else {
    state.runtime = { gameId, status: "starting" };
    state.orphan = false;
    emit(); await wait(1500);
    if (game?.failsToStart) {
      state.runtime = { gameId, status: "failed" };
      state.feedback = "The game action failed. Review its status below; further details are in the Nexus host console.";
    } else {
      state.runtime = { gameId, status: "running" };
      state.startedAt = Date.now();
      state.feedback = "Game ready. Choose Open game to play.";
    }
  }
  state.pending = null;
  emit();
}

const refresh = () => { state.feedback = "Library refreshed."; emit(); };

function toast(text) {
  let el = document.querySelector(".mk-toast");
  if (!el) { el = document.createElement("div"); el.className = "mk-toast"; document.body.append(el); }
  el.textContent = text; el.classList.add("show");
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 2200);
}

// Click delegation shared by all studies:
//   [data-act="start|stop" data-game]   [data-open="play|board" data-game]   [data-copy]   [data-refresh]
document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-act],[data-open],[data-copy],[data-refresh]");
  if (!el) return;
  if (el.dataset.act) { event.preventDefault(); void act(el.dataset.game, el.dataset.act); }
  else if (el.dataset.open) { event.preventDefault(); toast(`Would open ${el.dataset.open === "board" ? "board display" : "game"} in a new tab`); }
  else if (el.dataset.copy !== undefined) {
    event.preventDefault();
    navigator.clipboard?.writeText(el.dataset.copy).catch(() => {});
    toast("Link copied");
  } else if (el.dataset.refresh !== undefined) { event.preventDefault(); refresh(); }
});

// ---- scenario switcher so you can see every state without waiting around
const scenarios = {
  idle: () => { Object.assign(state, { runtime: null, pending: null, unavailable: false, orphan: false, feedback: "", startedAt: null }); },
  running: () => { Object.assign(state, { runtime: { gameId: "cinder-court", status: "running" }, pending: null, unavailable: false, orphan: false, feedback: "Game ready. Choose Open game to play.", startedAt: Date.now() - 1000 * 60 * 14 }); },
  starting: () => { Object.assign(state, { runtime: { gameId: "salt-and-sail", status: "starting" }, pending: { gameId: "salt-and-sail", operation: "start" }, unavailable: false, orphan: false, feedback: "Starting game…" }); },
  failed: () => { Object.assign(state, { runtime: { gameId: "orbit-heist", status: "failed" }, pending: null, unavailable: false, orphan: false, feedback: "The game action failed. Review its status below; further details are in the Nexus host console." }); },
  offline: () => { Object.assign(state, { runtime: { gameId: "cinder-court", status: "running" }, pending: null, unavailable: true, orphan: false, feedback: "" }); },
};
function mountScenarioBar() {
  const bar = document.createElement("div");
  bar.className = "mk-bar";
  bar.innerHTML = `<b>Mock state</b>` + Object.keys(scenarios).map((k) => `<button data-sc="${k}">${k}</button>`).join("");
  document.body.append(bar);
  bar.addEventListener("click", (e) => {
    const k = e.target.dataset?.sc; if (!k) return;
    scenarios[k](); emit();
  });
  const style = document.createElement("style");
  style.textContent = `
  .mk-bar{position:fixed;z-index:99999;left:50%;bottom:12px;transform:translateX(-50%);display:flex;gap:4px;align-items:center;padding:5px 6px 5px 10px;border-radius:99px;background:#111d;backdrop-filter:blur(8px);color:#ddd;font:600 11px/1 ui-monospace,Consolas,monospace;box-shadow:0 4px 18px #0006;max-width:calc(100vw - 16px);overflow-x:auto}
  .mk-bar b{opacity:.55;font-weight:600;margin-right:4px;white-space:nowrap}
  .mk-bar button{all:unset;cursor:pointer;padding:6px 9px;border-radius:99px;background:#fff1;color:#eee}
  .mk-bar button:hover{background:#fff3}
  .mk-toast{position:fixed;z-index:99999;left:50%;top:18px;transform:translate(-50%,-30px);opacity:0;pointer-events:none;padding:10px 16px;border-radius:10px;background:#111;color:#fff;font:600 13px system-ui;transition:.25s}
  .mk-toast.show{opacity:1;transform:translate(-50%,0)}`;
  document.head.append(style);
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const range = (g) => g.players.min === g.players.max ? `${g.players.min}` : `${g.players.min}–${g.players.max}`;
const fmtElapsed = (t) => { if (!t) return "0:00"; const s = Math.max(0, Math.floor((Date.now() - t) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const hostOnly = (u) => u.replace(/^https?:\/\//, "");

// Tiny per-game glyphs (48x48, currentColor) used as stand-in key art.
const GLYPHS = {
  "cinder-court": '<path d="M5 38 3 14l12 10L24 8l9 16 12-10-2 24z"/><rect x="5" y="40" width="38" height="4" rx="1"/>',
  "salt-and-sail": '<path d="M23 5v26H8zM26 11v20h14z"/><path d="M5 35h38l-7 8H12z"/>',
  "lanternfall": '<path d="M18 4h12v5H18zM14 11h20l3 7v14l-5 8H16l-5-8V18z"/><circle cx="24" cy="26" r="5" fill="#0006"/>',
  "hex-harvest": '<path d="M24 3l18 10.5v21L24 45 6 34.5v-21z"/><path d="M24 13l9 5.2v10.4L24 34l-9-5.2V18.2z" fill="#0004"/>',
  "trick-tavern": '<path d="M24 3c10 12 20 18 20 27a9 9 0 0 1-16 5l2 10H18l2-10a9 9 0 0 1-16-5C4 21 14 15 24 3z"/>',
  "orbit-heist": '<circle cx="24" cy="24" r="11"/><ellipse cx="24" cy="24" rx="21" ry="7" fill="none" stroke="currentColor" stroke-width="3" transform="rotate(-24 24 24)"/>',
};
function glyph(id, cls = "") { return `<svg class="${cls}" viewBox="0 0 48 48" fill="currentColor" aria-hidden="true">${GLYPHS[id] ?? ""}</svg>`; }

window.MK = { ORIGIN, GAMES, statusLabel, subscribe, getView, act, refresh, toast, mountScenarioBar, esc, range, fmtElapsed, hostOnly, glyph };
})();
