import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const qrSource = await readFile(new URL("../public/qr.js", import.meta.url), "utf8");

// Small DOM boundary double; behavior is exercised by the actual portal script.
async function portal(initial, { qr = false, origin = "http://nexus.test:3000" } = {}) {
  const nodes = new Map();
  const document = new EventTarget();
  class Element extends EventTarget {
    constructor(tag) {
      super();
      this.tagName = tag;
      this.dataset = {};
      this.children = [];
      this.textContent = "";
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  for (const id of ["games", "library-status", "runtime-status", "action-feedback", "confirm-action",
    "refresh-library", "confirm-description", "cancel-action", "continue-action"]) {
    nodes.set(`#${id}`, new Element("div"));
  }
  const walk = (node) => [node, ...node.children.flatMap(walk)];
  document.createElement = (tag) => new Element(tag);
  document.querySelector = (selector) => nodes.get(selector);
  document.querySelectorAll = () => [...nodes.values()].flatMap(walk).filter((node) => node.dataset.focusKey);
  document.activeElement = null;
  let state = initial;
  let networkError = false;
  let actionResponse = { ok: true, payload: {} };
  let actionHandler = null;
  const calls = [];
  const context = createContext({
    document, window: { location: { origin } }, URL, TextEncoder,
    AbortSignal, setInterval() {}, fetch: async (path, options) => {
      calls.push({ path, options });
      if (networkError) throw new Error("offline");
      if (options.method === "POST") {
        if (actionHandler) await actionHandler();
        return { ok: actionResponse.ok, json: async () => actionResponse.payload };
      }
      return { ok: true, json: async () => structuredClone(state) };
    },
  });
  if (qr) runInContext(qrSource, context);
  runInContext(source, context);
  await runInContext("refresh()", context);
  return {
    nodes, calls,
    controls: () => document.querySelectorAll(),
    text: (id) => walk(nodes.get(`#${id}`)).map((node) => node.textContent).join(" "),
    refresh: () => runInContext("refresh()", context),
    act: (id, action) => runInContext(`runAction(${JSON.stringify(id)}, ${JSON.stringify(action)})`, context),
    setState(value) { state = value; },
    setOffline(value) { networkError = value; },
    setActionResponse(value) { actionResponse = value; },
    setActionHandler(value) { actionHandler = value; },
    document,
  };
}

const game = (id = "game-a", extra = {}) => ({
  id, name: id, players: { min: 1, max: 4 }, capabilities: { tvLess: true }, status: "configured", ...extra,
});
const library = (games, runtime = null, busy = false) => ({ games, runtime, busy });

test("portal preserves focus on polling, shows same-origin ready links and pauses controls offline", async () => {
  const p = await portal(library([game()]));
  const start = p.controls().find((node) => node.dataset.focusKey === "game-a:start");
  start.focus();
  await p.refresh();
  assert.equal(p.document.activeElement, start);
  assert.ok(p.controls().includes(start), "unchanged poll must preserve the actual focused node");
  assert.equal(p.controls().filter((node) => node.tagName === "a").length, 0);

  p.setState(library([game("game-a", {
    status: "running", playUrl: "/games/game-a/", boardUrl: "/games/game-a/board/",
  })], { gameId: "game-a", status: "running" }));
  await p.refresh();
  assert.deepEqual(p.controls().filter((node) => node.tagName === "a").map((node) => node.href), [
    "http://nexus.test:3000/games/game-a/", "http://nexus.test:3000/games/game-a/board/",
  ]);
  p.setOffline(true);
  await p.refresh();
  assert.match(p.text("library-status"), /Connection lost/);
  assert.equal(p.controls().filter((node) => node.tagName === "a").length, 0);
  assert.ok(p.controls().find((node) => node.textContent === "Stop game").disabled);
  assert.equal(p.controls().find((node) => node.textContent === "Retry stop active game").disabled, false);
  p.setOffline(false);
  await p.refresh();
  assert.equal(p.controls().find((node) => node.textContent === "Stop game").disabled, false);
});

test("portal disables switching during cleanup and can stop a removed registration", async () => {
  const p = await portal(library([game("game-b")], { gameId: "game-a", status: "failed" }));
  assert.equal(p.controls().find((node) => node.textContent === "Switch to this game").disabled, true);
  assert.equal(p.controls().find((node) => node.textContent === "Stop active game").disabled, false);
  assert.match(p.text("runtime-status"), /Cleanup is unresolved/);
});

test("portal confirms switching and retains the originally confirmed runtime in its request", async () => {
  const p = await portal(library([game(), game("game-b")], { gameId: "game-a", status: "running" }));
  let action = p.act("game-b", "start");
  assert.equal(p.nodes.get("#confirm-action").open, true);
  assert.match(p.text("confirm-description"), /stops game-a/);
  p.nodes.get("#cancel-action").dispatchEvent(new Event("click"));
  await action;
  assert.equal(p.calls.filter((call) => call.options.method === "POST").length, 0);

  action = p.act("game-b", "start");
  p.setState(library([game(), game("game-b")], { gameId: "game-b", status: "running" }));
  await p.refresh();
  p.setActionResponse({ ok: false, payload: { error: "RUNTIME_CHANGED" } });
  p.nodes.get("#continue-action").dispatchEvent(new Event("click"));
  await action;
  const post = p.calls.find((call) => call.options.method === "POST");
  assert.equal(post.path, "/api/games/game-b/start");
  assert.equal(post.options.headers["x-nexus-active-game"], "game-a");
  assert.equal(post.options.headers["x-nexus-action"], "1");
  assert.match(p.text("action-feedback"), /active game changed/);
});

test("portal hides ready links during mutations, handles failure and refreshes to recover", async () => {
  const p = await portal(library([game()]));
  let finish;
  p.setActionHandler(() => new Promise((resolve) => { finish = resolve; }));
  const action = p.act("game-a", "start");
  assert.ok(p.controls().find((node) => node.textContent === "Start game").disabled);
  p.setState(library([game("game-a", { status: "running", playUrl: "/games/game-a/" })], {
    gameId: "game-a", status: "running",
  }));
  await p.refresh();
  assert.equal(p.controls().filter((node) => node.tagName === "a").length, 0);
  p.setActionResponse({ ok: false, payload: { error: "LIFECYCLE_FAILED", detail: "secret-command-token" } });
  p.setState(library([game("game-a", { status: "failed", message: "Try starting again." })]));
  finish();
  await action;
  assert.match(p.text("action-feedback"), /game action failed/);
  assert.equal(p.text("action-feedback").includes("secret-command-token"), false);
  assert.equal(p.controls().find((node) => node.textContent === "Start game").disabled, false);
});

const running = (extra = {}) => library([game("game-a", {
  status: "running", playUrl: "/games/game-a/", boardUrl: "/games/game-a/board/", ...extra,
})], { gameId: "game-a", status: "running" });
const walkAll = (node) => [node, ...node.children.flatMap(walkAll)];
const images = (p) => walkAll(p.nodes.get("#games")).filter((node) => node.tagName === "img");

test("portal offers QR codes only for ready same-origin links and hides them when locked", async () => {
  const none = await portal(running());
  assert.equal(none.controls().filter((node) => /QR/.test(node.textContent)).length, 0, "no QR without the generator");

  const p = await portal(library([game()]), { qr: true });
  assert.equal(p.controls().filter((node) => /QR/.test(node.textContent)).length, 0, "nothing to share before ready");

  p.setState(running());
  await p.refresh();
  const toggles = p.controls().filter((node) => /QR/.test(node.textContent));
  assert.deepEqual(toggles.map((node) => node.textContent), ["Show game QR", "Show board display QR"]);
  assert.equal(images(p).length, 0);

  toggles[0].dispatchEvent(new Event("click"));
  assert.equal(images(p).length, 1);
  assert.match(images(p)[0].src, /^data:image\/svg\+xml,%3Csvg/);
  assert.equal(images(p)[0].alt, "QR code for the game link");
  assert.match(p.text("games"), /http:\/\/nexus\.test:3000\/games\/game-a\/(?!board)/);
  assert.ok(p.controls().find((node) => node.textContent === "Hide game QR"));
  assert.doesNotMatch(p.text("games"), /local-only address/);

  p.controls().find((node) => node.textContent === "Show board display QR").dispatchEvent(new Event("click"));
  assert.equal(images(p).length, 2);
  p.controls().find((node) => node.textContent === "Hide game QR").dispatchEvent(new Event("click"));
  assert.equal(images(p).length, 1);

  // Mutations and lost connections remove the links, and their QR codes with them.
  p.setOffline(true);
  await p.refresh();
  assert.equal(images(p).length, 0);
  assert.equal(p.controls().filter((node) => /QR/.test(node.textContent)).length, 0);
});

test("portal warns that a QR built from a loopback origin only works on the host", async () => {
  const p = await portal(running(), { qr: true, origin: "http://localhost:3000" });
  p.controls().find((node) => node.textContent === "Show game QR").dispatchEvent(new Event("click"));
  assert.match(p.text("games"), /local-only address/);
  assert.match(p.text("games"), /http:\/\/localhost:3000\/games\/game-a\//);
});
