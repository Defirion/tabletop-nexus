# Nexus Game Authoring Guide

**Status:** Draft planning guidance  
**Authority:** `GAME-CONTRACT.md` remains the normative compatibility contract. This guide is planning input for games intended to work well with Nexus; it is not a requirement to read on every implementation task.

## Purpose

Use this guide while planning a new browser game or adapting an existing one for Tabletop Nexus. The goal is to make Nexus compatibility a normal design constraint early, while the cost of aligning games is still low.

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

That principle does **not** mean every game should invent a completely different integration shape. With only a small number of games, it is cheaper to standardize useful cross-game behavior now than to migrate many incompatible games later.

The working design direction is therefore:

> **Standardize the behaviors Nexus and its operators need to rely on. Keep game rules, game-specific payloads, and implementation mechanisms game-owned.**

Be deliberately strict about lifecycle, runtime topology, browser URL behavior, recoverability, public/private boundaries, and the supported player experience. Be deliberately flexible about rules engines and game-specific wire payloads.

Nexus should not need special branches for:

- a particular game's rules;
- hidden game information;
- scoring;
- board layout;
- turn order;
- game-specific API or WebSocket payloads.

Repeated cross-game needs should first be expressed as common behavior. Only standardize a particular mechanism when Nexus itself genuinely needs to depend on that mechanism.

## Current candidate contract direction

The following items are stronger than the current schema-1 contract and are recorded here for deliberate review before any of them are promoted into `GAME-CONTRACT.md`.

A future Nexus compatibility contract is expected to require, or strongly prefer, the following common shape:

- one Nexus-supervised production runtime;
- one Nexus-assigned private browser-facing port;
- `HOST`, `PORT`, and `BASE_PATH` support;
- one normal player entrypoint beneath `BASE_PATH`;
- production frontend assets served by that same supervised runtime rather than a separate development server;
- same-origin browser communication beneath `BASE_PATH`;
- standard health/readiness behavior;
- graceful shutdown and full port release;
- complete play without a mandatory dedicated display;
- recovery from ordinary browser refresh/transient network interruption where the game has persistent player seats/sessions;
- a deliberate boundary between public browser data and authoritative/private server data.

This section is **not yet the normative schema**. The next contract-design session should classify each candidate as:

```text
STANDARDIZE NOW
GUIDANCE ONLY
GAME-OWNED
```

and then update `GAME-CONTRACT.md` only for the items intentionally promoted.

## Required compatibility seam today

The exact normative requirements currently live in `GAME-CONTRACT.md`. During planning, make sure the game can already provide:

- a valid schema-1 `boardgame.json`;
- one Nexus-visible runtime command;
- one private HTTP port from Nexus's perspective;
- `HOST`, `PORT`, and `BASE_PATH` support;
- a side-effect-free health endpoint;
- complete play without a mandatory dedicated display;
- normal termination initiated by Nexus.

A game may have multiple internal packages or modules. "One runtime" means Nexus launches and supervises one production process boundary, not that the source tree or internal code architecture must be monolithic.

## One production runtime, not one trust boundary

Development tooling may use multiple processes. The Nexus production launch path should not.

For a typical web game the desired production shape is:

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

The important distinction is:

> **Serving the frontend from the game runtime does not make private server state public.**

The runtime must serve only explicitly public built web artifacts. Server source, private data, credentials, RNG state, hidden cards/tiles, room secrets, host capabilities, and other authoritative information must remain outside the public static root and reach browsers only through deliberate game-owned projections or responses.

Do not expose a repository root as a static directory. Prefer a dedicated build output such as:

```text
packages/web/dist/
```

or another explicit public artifact directory.

Frontend builds must also avoid accidentally bundling private values. Shared protocol **types** or public constants are fine; server-only secrets/data must not become runtime imports of browser bundles.

### Existing-game lesson: Pirate Island

Pirate Island is already close to this shape: one LAN server serves a bounded web build directory, JSON room APIs, SSE state updates, and `/healthz`, and its CLI already reads `HOST` and `PORT`.

Its Nexus adaptation is mainly an outer-seam change: `BASE_PATH`/URL hygiene and final production-runtime behavior, not a rewrite of its room or transport model.

### Existing-game lesson: Captain Flip / Flippin Stories

Captain Flip's current development topology uses Vite for the browser assets and a separate authoritative WebSocket process. Vite proxies same-origin `/ws` traffic during development.

For Nexus production, the intended adaptation is to serve the already-built public frontend from the supervised game runtime and expose the game's WebSocket endpoint on the same private port. This removes a development process; it does **not** weaken Captain Flip's hidden-information boundary.

Captain Flip already keeps its private seed, bag order, hidden tile/cell backs, and other authoritative information server-side and sends deliberately redacted public state to clients. That separation should be preserved.

## Do not design around a fixed public host or port

A Nexus-launched game receives:

```text
HOST=<private bind address>
PORT=<Nexus-selected private port>
BASE_PATH=/games/<game-id>
```

Plan so the production/Nexus runtime can honor those values.

Avoid production assumptions such as:

```text
localhost:3000
192.168.1.20:5173
/ws at the origin root
/api at the origin root
```

Those may be convenient during development, but the Nexus runtime must not depend on them.

## BASE_PATH and same-origin behavior

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

The emerging stricter direction is that the browser should use **same-origin** URLs in Nexus mode. A game should not need to know Nexus's LAN/public hostname, TLS termination, Cloudflare setup, or internal private port.

### Existing-game lesson: Pirate Island

Pirate Island's current browser code and HTML use several root-absolute asset/API paths. Those need base-path adaptation, but its HTTP/SSE protocol can remain intact.

### Existing-game lesson: Captain Flip

Captain Flip already has a useful same-origin WebSocket pattern: the browser derives `ws:`/`wss:` from the current page origin and connects to `/ws`. The Nexus adaptation should preserve the same-origin property while making the endpoint base-path-safe.

## Standardize behavior, not transport choice

Nexus must support ordinary browser transports without requiring every game to adopt the same transport.

Valid designs may include:

- request/response HTTP APIs;
- Server-Sent Events;
- WebSockets;
- combinations of the above.

The contract may become stricter about **what the transport must achieve**—for example base-path safety, reconnect behavior, message-size safety, and clean shutdown—without forcing every game to use WebSockets or every game to use SSE.

The game owns payload formats and game semantics. Nexus proxies traffic but should not interpret game messages.

Pirate Island currently uses HTTP plus SSE. Captain Flip currently uses an authoritative WebSocket protocol. Both remain valid implementation choices.

## Sessions, lobbies, and reconnect semantics

The exact room protocol should remain game-owned, but the common user-facing behavior deserves stronger standardization than the first draft assumed.

For multiplayer games with durable player seats/sessions, candidate common expectations include:

- a player can reach the game through its normal Nexus entrypoint and create/join the relevant game session;
- a transient transport disconnect does not itself destroy the player's seat;
- refreshing/reopening the browser can reclaim an existing seat/session when the game still exists;
- reconnect recovers authoritative current state rather than relying on the old TCP/WebSocket/SSE connection to survive;
- room/session/player identifiers remain opaque to Nexus;
- the game, not Nexus, decides admission, room lifecycle, host/player roles, and game-specific authorization.

The mechanism remains game-owned. Nexus does not need every game to use the same room-code format, token shape, storage key, or handshake packet.

### Existing-game examples

Pirate Island exposes room creation/join endpoints, stores a player session identity, and reconnects live state through SSE.

Captain Flip supports room browsing/join, stores player reconnect tokens, retries WebSockets with backoff, and receives full authoritative state after reconnect. Its TV host capability is deliberately separate from ordinary player identity.

These are different mechanisms implementing similar useful behavior.

## Server authority and hidden information

Both current games are server-authoritative: browsers send player choices/intents and the server owns legality/shared state.

That gives useful properties for the class of games Nexus currently targets:

- hidden information can stay off clients;
- reconnect can restore authoritative state;
- browser clients can remain presentation/input surfaces;
- one source decides legal shared-state transitions;
- curious browser clients cannot learn server-only state merely by inspecting JavaScript messages.

Whether **server-authoritative shared state becomes a mandatory Nexus game-contract rule** is intentionally left for the next contract-design session. It is a strong candidate because both current games already fit it and future multiplayer tabletop games are likely to benefit, but it is a game-design constraint rather than merely a runtime constraint and should therefore be chosen deliberately.

Regardless of that future decision, any game that claims information is hidden from a player must enforce that boundary on the server side. Hiding HTML/CSS elements is not a secrecy mechanism.

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

If a dedicated display carries required information or controls, adaptation planning must provide equivalent access through the no-TV experience as well.

Pirate Island is already phone-first. Captain Flip currently has distinct TV board and phone clients, so its Nexus adaptation should preserve the useful board view while making it optional for complete play. That belongs inside Captain Flip, not as special Captain Flip logic in Nexus.

## Health endpoint

Expose the manifest-declared health path with these properties:

- HTTP 200 only when the runtime is ready for players;
- no authentication;
- no room/session requirement;
- no side effects;
- prompt response;
- no sensitive runtime data.

If the frontend must be built or data loaded at startup, do not report healthy until those prerequisites are usable.

A possible future generic Nexus status surface beyond health—such as approximate room/player/session counts—is **not decided**. It should be considered only if Nexus genuinely needs game-reported semantic information that cannot be safely derived at the proxy/runtime layer.

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
- Can production run as one supervised process/port?
- Does it honor `HOST`, `PORT`, and `BASE_PATH`?
- What health endpoint indicates actual readiness?
- Does the production runtime serve only an explicit public frontend build directory?
- What data/state must remain server-only, and how is its public projection/redaction enforced?
- Which browser transports does it use: HTTP, SSE, WebSocket?
- Are every asset/API/transport URL and redirect compatible with `BASE_PATH` and same-origin Nexus hosting?
- How are rooms/lobbies owned by the game?
- What happens when a phone reloads or reconnects?
- Can an existing seat/session be recovered without the previous network connection surviving?
- Where does shared game authority live?
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
- same-origin browser behavior under HTTP and eventual HTTPS proxying;
- refresh/reconnect behavior for games with durable sessions;
- redirect/link behavior;
- public static-root containment (private/server files are not browser-reachable);
- graceful shutdown and port release;
- complete TV-less play path at the game-specific verification layer.

The test harness should verify the integration seam, not game rules.

## What should remain game-owned unless Nexus has a reason to care

Do not standardize an implementation detail merely because one or two games currently use it.

Likely game-owned details include:

- exact room-code format;
- exact reconnect-token format;
- exact HTTP/SSE/WebSocket message schema;
- game-specific actions/intents/events;
- engine/reducer structure;
- exact host-capability representation;
- frontend framework/build tool/package manager;
- persistence technology;
- game-specific rate limits and payload limits beyond Nexus-wide safety ceilings.

The key test is:

> **Would having every future Nexus game obey this rule materially simplify launching, routing, supervising, recovering, securing, testing, or operating the platform?**

If yes, consider standardizing the behavior now while migration cost is low. If no, leave it game-owned.

## Next contract review queue

Before further game-adapter work, revisit this guide and decide at least:

1. Which candidate behaviors become mandatory in the next `GAME-CONTRACT.md` revision?
2. Should server-authoritative shared state be a Nexus compatibility requirement or strong guidance?
3. How strict should reconnect/session recovery semantics be?
4. Does every multiplayer Nexus game need a create/join/session concept, or must games with no room concept remain first-class?
5. Should Nexus ever consume a tiny generic game-reported status surface beyond health, or should room/player telemetry remain proxy-derived/game-private?
6. Which compatibility checks belong in a reusable Nexus harness versus each game's own verifier?

The aim is to make the contract stricter **before** there are many games, without turning Nexus into a framework that understands how those games work.
