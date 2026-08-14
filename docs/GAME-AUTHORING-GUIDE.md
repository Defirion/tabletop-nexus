# Nexus Game Authoring Guide

**Status:** Draft planning guidance  
**Authority:** `GAME-CONTRACT.md` remains the normative compatibility contract. This guide is planning input for games intended to work well with Nexus; it is not a requirement to read on every implementation task.

## Purpose

Use this guide while planning a new browser game or adapting an existing one for Tabletop Nexus. The goal is to make Nexus compatibility a normal design constraint early, without forcing every game into the same engine, room model, transport, frontend framework, or persistence scheme.

A useful flow is:

```text
GAME-AUTHORING-GUIDE.md
          |
          v
 game planning / architecture
          |
          v
project-specific PLAN / requirements
          |
          v
implementation + compatibility tests
```

Once the relevant expectations have been incorporated into that game's own plan and contracts, ordinary implementation work should follow the game repository's local documentation rather than repeatedly reinterpreting this guide.

## Core principle

**Nexus knows how to run games; Nexus does not know how games work.**

A Nexus-ready game should expose a small runtime seam and keep game-specific concepts behind it.

Nexus should not need special branches for:

- a particular game's room/lobby model;
- its rules engine;
- hidden information;
- reconnect tokens;
- scoring;
- player roles;
- board layout;
- turn order;
- game-specific API payloads.

If Nexus needs to understand one of those concepts, first ask whether the game can satisfy the existing runtime/browser boundary instead.

## Required compatibility seam

The exact normative requirements live in `GAME-CONTRACT.md`. During planning, make sure the game can provide:

- a valid schema-1 `boardgame.json`;
- one Nexus-visible runtime command;
- one private HTTP port from Nexus's perspective;
- `HOST`, `PORT`, and `BASE_PATH` support;
- a side-effect-free health endpoint;
- complete play without a mandatory dedicated display;
- normal termination initiated by Nexus.

A game may have multiple internal packages or modules. "One process" means Nexus launches and supervises one runtime boundary, not that the source tree must be monolithic.

## Do not design around a fixed public host or port

A Nexus-launched game receives:

```text
HOST=<private bind address>
PORT=<Nexus-selected private port>
BASE_PATH=/games/<game-id>
```

Plan so the production/Nexus runtime can honor those values.

Avoid assumptions such as:

```text
localhost:3000
192.168.1.20:5173
/ws at the origin root
/api at the origin root
```

Those may be fine for local development, but the Nexus runtime must not depend on them.

## BASE_PATH is the main browser-facing constraint

A game mounted at:

```text
/games/example-game
```

must keep its browser-facing traffic under that path.

This includes:

- HTML navigation;
- JavaScript and CSS;
- images and other assets;
- API calls;
- WebSocket connections;
- SSE/EventSource connections;
- redirects;
- cookies where used;
- service workers where used.

Prefer deriving URLs from the current document/base URL or a single base-path helper instead of scattering root-absolute strings such as `/api/...` or `/assets/...` throughout the client.

### Existing-game lesson: Pirate Island

Pirate Island is already close to the desired runtime shape: one LAN server serves static files, a JSON room API, SSE state updates, and `/healthz`, and its CLI already reads `HOST` and `PORT`. Its current browser code and HTML use root-absolute asset/API paths, so base-path adaptation should focus on URL generation rather than changing its room or transport model.

This is the kind of adaptation Nexus should encourage: fix the outer URL seam, not rewrite working game architecture.

## Transport is game-owned

Nexus must support ordinary browser transports without requiring games to adopt one protocol.

Valid designs include:

- request/response HTTP APIs;
- Server-Sent Events;
- WebSockets;
- combinations of the above.

The game owns payload formats and semantics. Nexus proxies traffic but should not interpret game messages.

### Existing-game lesson: Pirate Island

Pirate Island uses:

```text
HTTP POST/GET
+
SSE for live state
```

That is a valid Nexus architecture.

### Existing-game lesson: Captain Flip / Flippin Stories

Captain Flip currently uses an authoritative WebSocket server. The phone and board clients connect to same-origin `/ws`, reconnect automatically, and re-send stored seat identity where appropriate. This is also a valid Nexus architecture.

Nexus compatibility should not require converting one game to the other's transport.

## Rooms and lobbies belong to the game

Games may choose their own model, including:

- create-room then share a code;
- one room generated when the runtime starts;
- multiple rooms hosted by one runtime;
- browseable open rooms;
- explicit host admission;
- reconnect/session tokens;
- no room concept at all.

Nexus may show that a game process is running. It should not need to know which in-game rooms exist or who belongs to them.

### Existing-game examples

Pirate Island exposes room creation and join endpoints and lets the host start the room.

Captain Flip currently creates a server-owned room code, allows phones to browse/join hosted tables, stores player reconnect tokens in local storage, and keeps its TV host capability separate from ordinary player identity.

Both patterns should remain possible.

## Server-authoritative games are encouraged, not mandated

Both current games keep important state and legality on the server side. That is a strong pattern for shared-device games because:

- reconnect is simpler;
- hidden information can stay off clients;
- clients can remain presentation/input surfaces;
- one source decides legal state transitions.

A new game does not have to copy either engine architecture, but if players can affect shared state, decide deliberately where authority lives.

## Reconnect and refresh should be normal events

Phones lock, browsers refresh, Wi-Fi changes, and WebSockets/SSE reconnect.

Plan for recovery where the game needs it.

Useful patterns already present in the current games include:

- localStorage-held non-admin player/session identity;
- reconnect tokens that reclaim an existing seat;
- full state snapshots after reconnect;
- transport retry/backoff;
- disconnected/away state that does not immediately destroy the room.

Nexus should not own these tokens or reconnect rules.

## TV-less play is mandatory; dedicated displays remain optional

A compatible game must be fully playable without requiring a TV/board client.

That does **not** prohibit a dedicated display.

A game may support:

```text
phones only
phones + optional shared display
host/player combined view
one browser passed around
```

If a dedicated display currently carries required information or controls, adaptation planning must provide that information/control through the player/host experience as well.

### Existing-game impact

Pirate Island is already phone-first and naturally fits this requirement.

Captain Flip currently has distinct TV board and phone clients and therefore needs a Nexus adaptation that preserves the useful dedicated display while making it optional for complete play. That should be an adapter/product change inside the game, not special Captain Flip behavior inside Nexus.

## One Nexus-visible runtime

Development tooling may use multiple processes. The Nexus launch path should not.

Captain Flip currently runs a Vite frontend process plus a separate WebSocket process during development. Its Nexus adaptation should package/serve the built frontend and WebSocket endpoint behind one supervised runtime/port.

Do not infer from this that every game must use the same web server or build system. The requirement is only that Nexus sees one launch/health/stop boundary.

## Health endpoint

Expose the manifest-declared health path with these properties:

- HTTP 200 only when the runtime is ready for players;
- no authentication;
- no room/session requirement;
- no side effects;
- prompt response;
- no sensitive runtime data.

If the frontend must be built or data loaded at startup, do not report healthy until those prerequisites are usable.

## Shutdown and process behavior

The Nexus runtime should:

- remain attached to the process Nexus starts;
- not daemonize itself away from supervision;
- tolerate graceful termination;
- close HTTP/WS/SSE listeners and release the assigned port;
- avoid leaving helper processes behind.

Development watchers are not the Nexus runtime.

## Browser state and shared-origin hygiene

Current Nexus planning uses path-based game routing on one player origin. Games should therefore avoid avoidable cross-game coupling.

During planning:

- namespace localStorage/sessionStorage keys by game;
- scope cookies to the game's base path where practical;
- do not assume ownership of all origin storage;
- avoid origin-wide service workers;
- if a service worker is genuinely needed, scope it to the game's path;
- do not store Nexus/cloud infrastructure credentials in browser state.

The two current games already namespace their player/session storage keys, which is a useful pattern to retain.

## Public URLs and generated links

Do not construct player-facing URLs from guessed LAN interfaces, fixed development ports, or hard-coded HTTP when running under Nexus.

Games may still print convenient LAN URLs in standalone development mode.

For Nexus mode, prefer:

- relative URLs under `BASE_PATH`;
- browser-derived scheme/host for same-origin connections;
- a runtime helper that knows `BASE_PATH` when an absolute path is required.

This is especially important for QR codes, room links, WebSocket endpoints, redirects, and share buttons.

## Security boundary

A game should not require access to:

- Nexus admin APIs;
- Cloudflare credentials;
- Tailscale credentials/configuration;
- another game's state directory;
- another game's private port.

Games are trusted applications in the initial Nexus threat model, but ordinary dependency vulnerabilities are still possible. Keeping those dependencies unnecessary reduces future blast radius without forcing games into containers today.

## Resource expectations

Design games as modest, single-table services where practical.

The initial remote-deployment model plans around Nexus plus **one active game runtime at a time**. A game's exact memory/CPU budget is not fixed by the compatibility contract, but planning should avoid unnecessary resident services and measure real runtime usage before declaring a low-resource deployment profile supported.

## Planning checklist

When a new game is being planned for Nexus, answer these questions and copy the applicable answers into that game's own plan/requirements:

- What command will Nexus launch?
- Can it run as one supervised process/port?
- Does it honor `HOST`, `PORT`, and `BASE_PATH`?
- What health endpoint indicates actual readiness?
- Which browser transports does it use: HTTP, SSE, WebSocket?
- Are every asset/API/transport URL and redirect compatible with `BASE_PATH`?
- How are rooms/lobbies owned by the game?
- What happens when a phone reloads or reconnects?
- Where does game authority/hidden state live?
- Is the complete game playable with no dedicated display?
- If a dedicated display exists, how does the no-TV mode replace its required information/controls?
- Does graceful shutdown release all listeners/helpers?
- Are browser storage/cookies/service workers safely scoped?
- Does the game need outbound internet access or any unusual host capability?
- What compatibility tests will prove the above?

## Compatibility tests worth planning early

A future reusable Nexus compatibility fixture/harness should be able to establish at least:

- startup with non-default `HOST`, `PORT`, and `BASE_PATH`;
- health readiness;
- initial HTML load beneath `BASE_PATH`;
- static asset loading beneath `BASE_PATH`;
- game API traffic beneath `BASE_PATH`;
- WebSocket or SSE behavior when used;
- refresh/deep-link behavior where supported;
- redirect/link behavior;
- graceful shutdown and port release;
- complete TV-less play path at the game-specific verification layer.

The test harness should verify the integration seam, not game rules.

## What not to standardize prematurely

Do not add to `GAME-CONTRACT.md` merely because one current game uses it:

- a particular room-code format;
- a particular reconnect-token format;
- REST versus WebSocket versus SSE;
- server-authoritative reducer architecture;
- host capabilities;
- dedicated-display URLs;
- Vite, Node, npm, pnpm, or a frontend framework;
- persistence technology;
- game-specific rate limits or message schemas.

Promote something into the normative contract only when Nexus genuinely needs it to launch, route, supervise, or safely expose independent games.
