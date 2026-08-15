# Nexus Game Authoring Guide

**Status:** Draft planning guidance  
**Authority:** `GAME-CONTRACT.md` remains the currently implemented normative compatibility contract. This guide records the selected direction for the next contract revision and should influence planning for games intended to work well with Nexus.

## Purpose

Use this guide while planning a new browser game or adapting an existing one for Tabletop Nexus. The goal is to make Nexus compatibility a normal design constraint early, while the cost of aligning games is still low.

Once the relevant expectations have been copied into a game's own plan/requirements, ordinary implementation work should follow that repository's local documentation rather than repeatedly reinterpreting this guide.

## Core principle

**Nexus knows how to run games; Nexus does not know how games work.**

That does not mean every game should invent a different operational shape. With only a small number of games, it is cheaper to standardize useful cross-game behavior now than to migrate many incompatible games later.

The selected direction is:

> **Standardize the behaviors Nexus and its operators need to rely on. Keep game rules, game-specific payloads, and implementation mechanisms game-owned.**

Be strict about lifecycle, runtime topology, browser URL behavior, readiness, session recovery, shared-state authority, and the supported player experience. Be flexible about transport choice, game rules, lobby protocol details, persistence technology, and wire payloads.

## Classification landed for the next contract revision

The following decisions are settled planning input. They are not yet all implemented by the current schema-1 validator, so they should be promoted into `GAME-CONTRACT.md` together with the corresponding validator/tests rather than changing the normative contract in isolation.

### STANDARDIZE NOW

A future Nexus-compatible game should be required to provide this common shape:

- one Nexus-supervised production runtime;
- one Nexus-assigned private browser-facing port;
- `HOST`, `PORT`, and `BASE_PATH` support;
- one normal player landing page at the game root beneath `BASE_PATH`;
- production frontend assets served by that same supervised runtime rather than a separate development server;
- same-origin browser communication beneath `BASE_PATH`;
- a fixed private Nexus readiness endpoint at `GET /__nexus/status`;
- clean shutdown with listener/helper cleanup and full assigned-port release;
- complete play without a mandatory dedicated display;
- server-authoritative shared game state: the server is the board/source of truth and browsers are views/input surfaces;
- for session-based multiplayer games, a normal landing page that exposes currently joinable game-owned sessions/rooms and provides a way to create a new session;
- recovery from ordinary browser refresh/transient network interruption without requiring the previous TCP/WebSocket/SSE connection to survive;
- room/session/player identifiers that remain opaque to Nexus;
- a production static root containing only intended public browser artifacts.

### GUIDANCE ONLY

These are useful patterns but should not be core compatibility requirements yet:

- automatically reclaiming the exact prior seat when a reconnect identity is still valid;
- browser storage/cookie/service-worker namespacing beyond what same-origin/base-path safety requires;
- game-specific hidden-information/redaction design beyond keeping server-only data out of the public static root;
- modest resource usage targets before a concrete deployment profile has been measured;
- particular reconnect backoff, snapshot, caching, or persistence strategies.

### GAME-OWNED

Nexus should not standardize these unless a concrete platform need appears:

- HTTP vs SSE vs WebSocket transport choice;
- exact room-code format;
- exact reconnect-token format, storage location, or handshake;
- exact lobby/room API or message schema;
- game-specific actions, intents, events, scoring, turn order, and rules;
- engine/reducer/state-representation structure;
- exact host-capability representation;
- frontend framework, build tool, or package manager;
- persistence technology/model;
- game-specific payload/rate limits below any future Nexus-wide safety ceilings.

### DEFERRED / OPTIONAL LATER

A richer Nexus status surface is intentionally not required now. The fixed readiness endpoint gives Nexus a stable extension point, so optional fields such as room/player counts can be added later if a real operational need appears without changing the overall architecture.

## Current implemented seam and migration gate

`GAME-CONTRACT.md` and `src/registry.js` still define/enforce the current schema-1 manifest, including configurable `runtime.healthPath`.

Do not silently redefine schema 1 underneath already-valid manifests. Before the first real game adapters, the stricter contract should be promoted atomically with the relevant manifest validation and compatibility tests. `docs/PLAN.md` records that migration gate.

The desired future manifest no longer needs a configurable Nexus readiness path because the path itself becomes part of the compatibility contract.

## One production runtime, not one trust boundary

Development tooling may use multiple processes. The Nexus production launch path should not.

A typical production shape is:

```text
Nexus
  |
  v
one game runtime / one private port
  |
  +-- public built HTML/CSS/JS/assets
  +-- game HTTP API, if used
  +-- SSE, if used
  +-- WebSocket endpoint, if used
  +-- private authoritative state in server memory/storage
```

Serving built frontend files from the runtime does not make private server state public. The runtime must expose only an explicit public build directory, not the repository root or arbitrary server files.

Credentials, private configuration, authoritative state, and any information the game intentionally keeps server-only must stay outside that public static root. Stronger hidden-information/anti-cheat rules remain game-owned because Nexus is primarily intended for small trusted groups rather than competitive hosting.

## Nexus readiness status versus game health

Nexus readiness and game-owned diagnostics are deliberately separate concepts.

The selected Nexus management surface is:

```http
GET /__nexus/status
```

with at least:

```json
{
  "schema": 1,
  "ready": true
}
```

`ready` has one platform meaning:

> **Nexus may route players to this runtime.**

The endpoint is private to the Nexus-to-game runtime seam. It is queried directly on the Nexus-assigned private host/port and should not be exposed as a public player route under `BASE_PATH`.

Conceptually:

```text
process unreachable
    -> runtime unavailable

/__nexus/status reachable, ready=false
    -> starting / not ready

/__nexus/status reachable, ready=true
    -> running / ready for players
```

Games may independently keep endpoints such as `/healthz`, metrics, database checks, or diagnostics for their own use. Nexus does not need to know or interpret them.

Future fields such as `rooms` or `players` may be added only if Nexus develops a genuine operational need. They are not baseline requirements.

## `BASE_PATH` and same-origin behavior

A game mounted at:

```text
https://games.example.com/games/captain-flip/
```

must behave as an application living beneath its assigned `BASE_PATH`.

Browser navigation, HTML/CSS/JS/assets, APIs, WebSockets, SSE/EventSource connections, redirects, generated links, cookies where used, and service-worker scope where used must remain compatible with that mount.

The browser should communicate back to the same public Nexus origin rather than constructing LAN hosts, development ports, or direct game-server URLs.

Conceptually:

```text
Browser
   |
   | HTTPS / WSS / same-origin game traffic
   v
Nexus public route: /games/<id>/...
   |
   | private proxy traffic
   v
Nexus-assigned game HOST:PORT
```

The game should not need to know Nexus's LAN/public hostname, Cloudflare setup, TLS termination details, or its private port from browser code.

Development URLs such as `localhost:5173` are fine for development. They are not part of the Nexus production runtime contract.

## Sessions, room browsing, and reconnect behavior

The exact room protocol remains game-owned, but the common player experience should be standardized for session-based multiplayer games.

The normal game landing page should:

- show currently joinable game-owned sessions/rooms;
- let the player create a new game session;
- let the player join an appropriate existing session.

This is a browser/player behavior requirement, not a Nexus room API. Nexus does not parse room objects, decide which rooms are joinable, or own admission rules.

Reconnect behavior should satisfy these outcomes:

- a transient transport disconnect does not require the old network connection to survive;
- refreshing/reopening the browser can recover authoritative current game state when the game/session still permits recovery;
- reconnect should not create duplicate shared state merely because the old transport disappeared;
- room/session/player identifiers remain opaque to Nexus;
- the game owns admission, room lifecycle, host/player roles, and game-specific authorization.

Automatic reclaim of the exact prior seat is strongly preferred when the game's identity model supports it, but the token/storage/handshake mechanism remains game-owned.

## Server authority: the server is the board

For the class of multiplayer tabletop games Nexus targets, shared game state should be server-authoritative.

Browsers send player intent/input and render the server's current projection of the game. They do not independently own the canonical board and later reconcile competing versions.

This gives Nexus-compatible games a common operational model:

- one source of truth for shared state;
- reconnect can restore the current board from the runtime;
- all player devices converge on the same state;
- browsers remain replaceable views/input surfaces;
- persistence and game switching are easier to reason about;
- games that do contain private information have a natural place to keep it.

Nexus still does not understand the board, rules, actions, or payloads.

## Standardize behavior, not transport choice

Valid games may use:

- request/response HTTP;
- Server-Sent Events;
- WebSockets;
- combinations of the above.

Nexus routes/proxies these transports but does not interpret game messages.

A contract can require same-origin/base-path safety and reconnectable behavior without requiring every game to use the same network protocol.

## TV-less play is mandatory; dedicated displays remain optional

A compatible game must be fully playable without requiring a dedicated TV/board client.

A game may still support:

```text
phones only
phones + optional shared display
host/player combined view
one browser passed around
```

If a dedicated display contains required information or controls, the no-TV path must provide equivalent access somewhere else.

## Shutdown and process behavior

The production runtime should remain attached to the process Nexus starts and must not daemonize away from supervision.

When Nexus requests normal termination, the game must cleanly shut down, including:

- stop accepting new game traffic;
- close HTTP/WS/SSE listeners;
- release the Nexus-assigned port;
- terminate helper/child processes it owns;
- leave no background runtime that prevents the next game from starting cleanly.

Nexus should still have a forced-termination fallback after a timeout. The fallback protects the platform from a hung game; it is not the normal compatibility path.

## Browser state and shared-origin hygiene

Because games share one public origin under different paths, avoid unnecessary cross-game coupling.

Useful guidance includes:

- namespace localStorage/sessionStorage keys by game;
- scope cookies to the game path where practical;
- avoid origin-wide service workers;
- scope a service worker beneath the game path if one is genuinely needed;
- do not store Nexus/cloud infrastructure credentials in browser state.

These details remain guidance unless a concrete interoperability problem requires stronger standardization.

## Existing-game lessons

### Pirate Island

Pirate Island is already close to the selected production shape:

- one LAN server;
- built frontend served by that server;
- JSON room APIs;
- SSE state updates;
- `/healthz` for its own health semantics;
- `HOST` and `PORT` already supported.

Its main Nexus adaptation remains `BASE_PATH`/same-origin URL hygiene plus the future fixed private `/__nexus/status` readiness surface. Its HTTP/SSE room model does not need to be rewritten.

### Captain Flip / Flippin Stories

Captain Flip already provides several of the selected player/session behaviors:

- authoritative server-owned shared state;
- room browsing/join behavior;
- reconnect tokens;
- WebSocket reconnect and state recovery;
- optional TV/host capability separate from ordinary player identity.

Its development topology currently uses Vite plus a separate authoritative WebSocket process. The Nexus production adaptation should preserve those semantics while serving the built frontend and WebSocket endpoint from one supervised runtime/port.

The normal game root should remain the player entrypoint, including the familiar room-browsing/create/join experience. The dedicated display should remain useful but optional for complete play.

## Public URLs and generated links

Do not construct player-facing links from guessed LAN interfaces, fixed development ports, or hard-coded HTTP in Nexus mode.

Prefer relative/base-path-aware URLs and browser-derived scheme/host for same-origin connections.

This matters especially for:

- QR codes;
- room/share links;
- redirects;
- API paths;
- WebSocket endpoints;
- SSE endpoints.

## Security boundary

A game should not require access to:

- Nexus admin APIs;
- Cloudflare credentials;
- Tailscale credentials/configuration;
- another game's state directory;
- another game's private port.

The baseline compatibility rule is intentionally modest: the production web server must expose only intended public browser artifacts. Game-specific secrecy/redaction policy stays inside the game.

## Resource expectations

The initial deployment profile plans around Nexus plus **one active game runtime at a time**.

Do not invent a universal game CPU/RAM budget. Measure representative games and define supported deployment profiles from observed resource use with headroom.

## Planning checklist

When planning or adapting a Nexus game, answer these questions in that game's own plan/requirements:

- What command will Nexus launch?
- Can production run as one supervised process/port?
- Does it honor `HOST`, `PORT`, and `BASE_PATH`?
- Does `GET /__nexus/status` report Nexus readiness with the agreed minimal response?
- Does the runtime serve only an explicit public frontend build directory?
- Does all required browser traffic remain same-origin and under `BASE_PATH`?
- Which transports does the game use: HTTP, SSE, WebSocket?
- Where does authoritative shared game state live?
- For session-based multiplayer, does the normal landing page list joinable sessions and support create/join?
- What happens when a phone reloads or temporarily loses the network?
- Can current state be recovered without the previous connection surviving?
- Can the complete game be played without a dedicated display?
- Does graceful shutdown release listeners, helpers, and the assigned port?
- Are browser storage/cookies/service workers scoped sensibly?
- Does the game need outbound internet access or unusual host capability?
- Which checks belong in the reusable Nexus seam tests versus the game's own verifier?

## Compatibility tests worth planning early

A reusable Nexus compatibility harness should eventually establish at least:

- startup with non-default `HOST`, `PORT`, and `BASE_PATH`;
- fixed private `/__nexus/status` readiness behavior;
- initial HTML load beneath `BASE_PATH`;
- static assets beneath `BASE_PATH`;
- same-origin API traffic beneath `BASE_PATH`;
- WebSocket/SSE routing when used;
- HTTPS/WSS compatibility through the Nexus proxy;
- redirect/generated-link base-path safety;
- public static-root containment;
- graceful shutdown and port release.

Game-specific verification should establish the behavioral requirements Nexus cannot generically understand, including:

- session/room landing-page behavior when applicable;
- reconnect/current-state recovery;
- server-authoritative game behavior;
- complete TV-less play.

The reusable harness should verify the integration seam, not game rules.

## Decision test for future standardization

For any proposed new common rule, ask:

> **Would having every future Nexus game obey this rule materially simplify launching, routing, supervising, recovering, securing, testing, or operating the platform?**

If yes, consider standardizing the behavior. If no, leave it game-owned.

The goal is a strict, maintainable platform seam without turning Nexus into a generic tabletop-game engine.
