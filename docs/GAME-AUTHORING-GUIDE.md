# Nexus Game Authoring Guide

**Status:** Draft planning guidance  
**Authority:** `GAME-CONTRACT.md` remains the currently implemented normative compatibility contract. This guide records decisions selected for the next contract revision and should influence planning for games intended to work well with Nexus. Items marked `STANDARDIZE NOW` are not binding until the contract/schema, validator, and tests are migrated together.

Related architecture documents:

- `docs/DEPLOYMENT-MODEL.md` owns host/resource/deployment assumptions;
- `docs/REMOTE-PLAY.md` owns public-ingress, proxy-hardening, attribution, and remote-play security requirements.

This guide summarizes the consequences game authors need at the Nexus/game seam; it should not duplicate those deployment/security documents wholesale.

## Purpose

Use this guide while planning a new browser game or adapting an existing one for Tabletop Nexus. The goal is to make Nexus compatibility a normal design constraint early, while the cost of aligning games is still low.

Once the relevant expectations have been copied into a game's own plan/requirements, ordinary implementation work should follow that repository's local documentation rather than repeatedly reinterpreting this guide.

## Core principle

**Nexus knows how to run games; Nexus does not know how games work.**

That does not mean every game should invent a different operational shape. With only a small number of games, it is cheaper to standardize useful cross-game behavior now than to migrate many incompatible games later.

The selected direction is:

> **Standardize the behaviors Nexus and its operators need to rely on. Keep game rules, game-specific payloads, and implementation mechanisms game-owned.**

Be strict about lifecycle, runtime topology, browser URL behavior, readiness, session recovery, shared-state authority, and the supported player experience. Be flexible about transport choice, game rules, lobby protocol details, persistence technology, and wire payloads.

For any proposed new common rule, ask:

> **Would having every future Nexus game obey this rule materially simplify launching, routing, supervising, recovering, securing, testing, or operating the platform?**

If yes, consider standardizing the behavior. If no, leave it game-owned.

## Decisions selected for the next contract revision

The following decisions are settled planning input. They are not yet all implemented by the current schema-1 validator, so they should be promoted into `GAME-CONTRACT.md` together with the corresponding validator/tests rather than changing the normative contract in isolation.

### STANDARDIZE NOW

A future Nexus-compatible game should be required to provide this common shape:

- one Nexus-supervised production runtime;
- one Nexus-assigned private browser-facing port;
- `HOST`, `PORT`, and `BASE_PATH` supplied by Nexus as environment variables;
- the runtime binds its listener to the exact supplied `HOST` rather than widening to `0.0.0.0`, `::`, or another interface;
- `BASE_PATH` uses the canonical no-trailing-slash form `/games/<game-id>`;
- the normal player landing page is available publicly at `BASE_PATH/`;
- Nexus strips `BASE_PATH` before forwarding browser game traffic to the private runtime, so private game routes remain rooted at `/`;
- the runtime-management namespace `/__nexus` and `/__nexus/*` is reserved for the private Nexus-to-game seam and is never exposed through player proxying;
- production frontend content is served by that same supervised runtime rather than a separate development server;
- all required browser-facing URLs, APIs, WebSockets/SSE, redirects, and generated links work on the public Nexus origin beneath `BASE_PATH` rather than constructing direct LAN/private-port URLs;
- any game service worker is scoped so it cannot control the Nexus portal or sibling game paths;
- a fixed private Nexus readiness endpoint at `GET /__nexus/status`;
- clean shutdown on the Nexus graceful-termination signal, including listener/helper cleanup and full assigned-port release;
- complete play without a mandatory dedicated display;
- server-authoritative shared game state: the server is the board/source of truth and browsers are views/input surfaces;
- for session-based multiplayer games, a normal landing page that exposes currently joinable game-owned sessions/rooms and provides a way to create a new session;
- recovery from ordinary browser refresh/transient network interruption without requiring the previous TCP/WebSocket/SSE connection to survive;
- room/session/player identifiers that remain opaque to Nexus;
- only intended browser-facing artifacts/content are exposed; if files are served from disk, the runtime exposes an explicit public build/static root rather than the repository root or arbitrary server files.

### GUIDANCE ONLY

These are useful patterns but should not be core compatibility requirements yet:

- automatically reclaiming the exact prior seat when a reconnect identity is still valid;
- browser storage/cookie namespacing beyond what same-origin/base-path safety requires;
- game-specific hidden-information/redaction design beyond keeping server-only data out of public browser artifacts;
- designing for modest resource use while concrete supported deployment profiles and their limits are established from measurement;
- particular reconnect-token, backoff, snapshot, caching, or persistence strategies.

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
- game-specific payload/rate design, provided it fits inside Nexus/deployment-wide safety ceilings and resource limits.

### DEFERRED / OPTIONAL LATER

A richer Nexus status surface is intentionally not required now. The fixed readiness endpoint gives Nexus a stable extension point, so optional fields such as room/player counts can be added later if a real operational need appears without changing the overall architecture.

The baseline game contract also does **not** promise games a trustworthy public client IP or a particular forwarded-client header. Nexus owns transport-level client attribution and platform abuse controls. If trusted client attribution is ever exposed to games, it should be an explicit future contract rather than an accidental dependency on `X-Forwarded-For`, `CF-Connecting-IP`, or similar headers.

## Current implemented seam and migration gates

`GAME-CONTRACT.md` and `src/registry.js` still define/enforce the current schema-1 manifest, including configurable `runtime.healthPath`.

Do not silently redefine schema 1 underneath already-valid manifests. Before R1 implements Nexus readiness polling, migrate from configurable `runtime.healthPath` to the fixed `/__nexus/status` surface atomically with the contract/schema decision, manifest validation, and tests. Before the first real game adapters, promote the remaining selected behavioral requirements with their compatibility checks. `docs/PLAN.md` records both gates.

The desired future manifest no longer needs a configurable Nexus readiness path because the path itself becomes part of the compatibility contract.

## Launch environment and private bind

Nexus launches the manifest-declared runtime command and supplies these environment variables:

```text
HOST=<Nexus-selected private bind host>
PORT=<Nexus-selected private port>
BASE_PATH=/games/<game-id>
```

`BASE_PATH` is supplied without a trailing slash. The public player entrypoint is the corresponding path with `/` appended, for example:

```text
https://games.example.com/games/captain-flip/
```

The runtime must bind to the exact supplied `HOST` and `PORT`. It must not replace the supplied host with a wildcard bind such as `0.0.0.0` or `::` in Nexus production mode. If the assigned bind cannot be satisfied, startup should fail rather than widening exposure.

Development or standalone modes may use different convenient defaults; those defaults are not the Nexus production contract.

## One production runtime, not one trust boundary

Development tooling may use multiple processes. The Nexus production launch path should not.

A typical production shape is:

```text
Nexus
  |
  v
one game runtime / one private port
  |
  +-- public built/rendered HTML/CSS/JS/assets
  +-- game HTTP API, if used
  +-- SSE, if used
  +-- WebSocket endpoint, if used
  +-- private authoritative state in server memory/storage
```

HTTP, browser content, WebSocket upgrades, and SSE used by the game must all be reachable through that one Nexus-assigned browser-facing port. A separate Vite/dev server or secondary browser-facing production port is not part of the supported Nexus runtime shape.

Serving frontend content from the runtime does not make private server state public. Dynamically rendered or embedded assets are fine. If the runtime serves files from disk, it must expose only an explicit public build/static directory, not the repository root or arbitrary server files.

Credentials, private configuration, authoritative state, and any information the game intentionally keeps server-only must stay outside the browser-facing content surface. Stronger hidden-information/anti-cheat rules remain game-owned because Nexus is primarily intended for small trusted groups rather than competitive hosting.

For supported remote play, the process-isolation boundary is separate from the one-runtime topology: the game execution context must be isolated from Nexus control-plane access as required by `docs/DEPLOYMENT-MODEL.md` and `docs/REMOTE-PLAY.md`. One supervised process does not imply that it should share Nexus's OS security identity.

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

The endpoint is private to the Nexus-to-game runtime seam. It is queried directly on the Nexus-assigned private host/port and is not exposed as a public player route under `BASE_PATH`.

`/__nexus` is a reserved private runtime-management namespace. Nexus player routing must reject a request whose canonical post-`BASE_PATH` target is exactly `/__nexus` or begins `/__nexus/`, including encoded or otherwise ambiguous path forms that could canonicalize into that namespace. Games must not place player APIs/assets under the reserved namespace.

For the initial status schema:

- a well-formed status response returns HTTP `200` with a JSON object and `Content-Type: application/json`, whether `ready` is `true` or `false`;
- `schema` is the integer status-payload schema version and begins at `1`;
- `ready` is a required boolean;
- readers ignore unknown fields when the declared status schema is supported, allowing optional fields to be added compatibly;
- timeout, connection failure, non-`200`, malformed JSON, missing/invalid required fields, or an unsupported status schema are treated as **not ready** and surfaced through Nexus lifecycle/startup handling rather than routed to players.

Conceptually:

```text
process unreachable / invalid status
    -> runtime unavailable or startup failure

/__nexus/status valid, ready=false
    -> starting / not ready

/__nexus/status valid, ready=true
    -> running / ready for players
```

Games may independently keep endpoints such as `/healthz`, metrics, database checks, or diagnostics for their own use. Nexus does not need to know or interpret them.

Future fields such as `rooms` or `players` may be added only if Nexus develops a genuine operational need. They are not baseline requirements.

## `BASE_PATH`, prefix stripping, and same-origin behavior

A game mounted at:

```text
https://games.example.com/games/captain-flip/
```

receives:

```text
BASE_PATH=/games/captain-flip
```

Nexus owns the public mount prefix and strips it before proxying an ordinary player request to the private runtime. For example:

```text
browser requests:  /games/captain-flip/api/rooms
runtime receives:  /api/rooms

browser upgrades:  /games/captain-flip/ws
runtime receives:  /ws

browser requests:  /games/captain-flip/__nexus/status
Nexus rejects:      reserved private management namespace; never forwarded
```

The reserved-management rejection is applied after the public path has been canonicalized/validated, so equivalent encoded or traversal-like forms cannot bypass it.

The game therefore keeps ordinary private routes rooted at `/`, while using `BASE_PATH` when producing browser-facing URLs and build configuration. The `/__nexus` namespace is the exception: it is reserved to Nexus management and is not available for public game routes.

Browser navigation, HTML/CSS/JS/assets, APIs, WebSockets, SSE/EventSource connections, redirects, generated links, cookies where used, and service-worker scope where used must remain compatible with that public mount.

All required browser traffic should return to the public Nexus origin beneath the game's `BASE_PATH`, rather than constructing LAN hosts, development ports, or direct private game-server URLs.

Conceptually:

```text
Browser
   |
   | HTTPS / WSS / same-origin game traffic
   v
Nexus public route: /games/<id>/...
   |
   | validate/canonicalize; deny reserved /__nexus namespace;
   | otherwise strip /games/<id> and proxy privately
   v
Nexus-assigned game HOST:PORT
```

The game should not need to know Nexus's LAN/public hostname, Cloudflare setup, TLS termination details, or its private port from browser code.

Development URLs such as `localhost:5173` are fine for development. They are not part of the Nexus production runtime contract.

## Player presentation identity versus game-session identity

Nexus may maintain a small browser-local player profile so a friend does not have to type the same display name separately in every game.

Two concepts must remain distinct:

```text
presentation
  display name: "Alex"
  optional opaque Nexus browser/profile ID: nexus-client-...

in-game identity
  room/session
  seat/player record
  reconnect credential/token
  host/player capability
```

The **display name is presentation data**, not identity proof. It need not be unique, it may be editable, and two players may use the same name.

An opaque Nexus browser/profile ID, if used, must remain distinct from the display name. It identifies a Nexus browser profile for platform convenience; it is not automatically a game's seat ID, reconnect credential, authorization token, or admission decision.

Games continue to own room/session/seat identity and reconnect authority. A game may use a Nexus-provided display name as the suggested/default player name, while issuing and validating its own game-session identity for reconnect and authorization.

The exact handoff mechanism for the optional Nexus presentation profile is still to be selected before it becomes a compatibility requirement. Do not couple game protocols to the remote-play presence cookie or assume the presence identifier is the same thing as a player profile or game identity.

## Sessions, room browsing, and reconnect behavior

The exact room protocol remains game-owned, but the common player experience should be standardized for session-based multiplayer games.

The normal game landing page should:

- show currently joinable game-owned sessions/rooms;
- let the player create a new game session;
- let the player join an appropriate existing session;
- use a Nexus-provided display name as a default when the future presentation-profile handoff is available, without treating that name as reconnect authority.

This is a browser/player behavior requirement, not a Nexus room API. Nexus does not parse room objects, decide which rooms are joinable, or own admission rules.

Reconnect behavior should satisfy these outcomes:

- a transient transport disconnect does not require the old network connection to survive;
- refreshing/reopening the browser can recover authoritative current game state when the game/session still permits recovery;
- reconnect should not create duplicate shared state merely because the old transport disappeared;
- room/session/player identifiers remain opaque to Nexus;
- the game owns admission, room lifecycle, host/player roles, and game-specific authorization.

Automatic reclaim of the exact prior seat is strongly preferred when the game's identity model supports it. Reconnect tokens/session identifiers are a common pattern, but their exact format, storage, validation, and handshake remain game-owned.

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

## Client attribution belongs to Nexus unless explicitly contracted

The baseline game seam does not guarantee a trustworthy player IP address or specific forwarded header.

Nexus/remote-play infrastructure owns canonical transport attribution for platform rate limits, anomaly signals, and abuse controls. Games should not make security or player-identity decisions by blindly trusting `X-Forwarded-For`, `Forwarded`, `CF-Connecting-IP`, or similar headers received at the private runtime.

This is also a poor substitute for game identity: several friends on the same couch/network may share one apparent public IP.

If a future game genuinely needs trusted client attribution, define that as an explicit contract extension rather than depending on incidental proxy headers.

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

On the supported Linux runtime, Nexus initiates normal graceful shutdown with `SIGTERM`. Other supported platforms may use the documented platform equivalent.

When Nexus requests normal termination, the game must cleanly shut down, including:

- stop accepting new game traffic;
- close HTTP/WS/SSE listeners;
- release the Nexus-assigned port;
- terminate helper/child processes it owns;
- leave no background runtime that prevents the next game from starting cleanly.

Nexus should still have a forced-termination fallback after a timeout. The fallback protects the platform from a hung game; it is not the normal compatibility path.

## Browser state and shared-origin hygiene

Because games share one public origin under different paths, avoid unnecessary cross-game coupling.

A service worker, when used, **must** remain scoped beneath the game's own `BASE_PATH` and must never control the Nexus portal or sibling game paths.

Useful additional guidance includes:

- namespace localStorage/sessionStorage keys by game;
- scope cookies to the game path where practical;
- do not assume ownership of all origin-wide browser storage;
- do not store Nexus/cloud infrastructure credentials in browser state.

## Existing-game lessons

### Pirate Island

Pirate Island is already close to the selected production shape:

- one LAN server;
- built frontend served by that server;
- JSON room APIs;
- SSE state updates;
- `/healthz` for its own health semantics;
- `HOST` and `PORT` already supported.

Its main Nexus adaptation remains exact `BASE_PATH`/same-origin URL behavior plus the future fixed private `/__nexus/status` readiness surface. Its HTTP/SSE room model does not need to be rewritten.

### Captain Flip / Flippin Stories

Captain Flip already provides several of the selected player/session behaviors:

- authoritative server-owned shared state;
- room browsing/join behavior;
- reconnect tokens;
- WebSocket reconnect and state recovery;
- optional TV/host capability separate from ordinary player identity.

Its development topology currently uses Vite plus a separate authoritative WebSocket process. The Nexus production adaptation should preserve those semantics while serving the built frontend and WebSocket endpoint from one supervised runtime/port.

The normal game root should remain the player entrypoint, including the familiar room-browsing/create/join experience. A future Nexus presentation profile can supply a default display name, while Captain Flip continues to own reconnect tokens and seat identity. The dedicated display should remain useful but optional for complete play.

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

- Nexus admin APIs/listener;
- Nexus trusted player-ingress socket;
- Cloudflare credentials;
- Tailscale credentials/configuration;
- another game's state directory;
- another game's private port.

For supported remote play, the deployment must enforce the first two items from the game-runtime execution context even if public traffic exploits a game/runtime dependency. A game launched under Nexus's same OS identity is not by itself a sufficient isolation boundary when local socket/filesystem identity is being trusted.

The baseline compatibility rule is intentionally modest: the production web server must expose only intended public browser artifacts/content. Game-specific secrecy/redaction policy stays inside the game.

For the stronger public-ingress and proxy boundary, follow `docs/REMOTE-PLAY.md`; game code should not attempt to recreate Nexus's edge abuse controls or client-attribution policy.

## Resource and platform limits

The initial deployment profile plans around Nexus plus **one active game runtime at a time**.

Supported remote deployment will impose per-game/process CPU, memory, task/process, and file-descriptor limits, plus Nexus-wide HTTP/WebSocket/connection/rate safety ceilings. Those controls are architecturally decided; their concrete numeric values are calibrated from measurements and supported deployment profiles rather than invented in the game contract.

Game authors should therefore avoid unbounded resource use and design games to operate predictably inside measured limits. Do not encode one universal CPU/RAM number in game compatibility until a supported profile has actually established it.

See `docs/DEPLOYMENT-MODEL.md` for resource qualification and `docs/REMOTE-PLAY.md` for proxy/security limits.

## Planning checklist

When planning or adapting a Nexus game, answer these questions in that game's own plan/requirements:

- What command will Nexus launch?
- Can production run as one supervised process/port?
- Does it read `HOST`, `PORT`, and `BASE_PATH` from the Nexus-provided environment?
- Does it bind exactly to the supplied `HOST`/`PORT` rather than a wildcard interface?
- Does it treat `BASE_PATH` as `/games/<id>` without a trailing slash and generate the public landing path as `BASE_PATH/`?
- Are private runtime routes correct after Nexus strips `BASE_PATH` before proxying?
- Does the game keep player routes out of the reserved `/__nexus` runtime-management namespace?
- Does `GET /__nexus/status` report Nexus readiness with the agreed status-schema and failure semantics?
- If the runtime serves files from disk, is exposure restricted to an explicit public build/static root rather than repository/server files?
- Does all required browser traffic return to the Nexus origin beneath `BASE_PATH`?
- If a service worker exists, is its scope contained beneath `BASE_PATH`?
- Which transports does the game use: HTTP, SSE, WebSocket?
- Does the game avoid assuming a trustworthy client IP/forwarded header unless the contract explicitly supplies one?
- Where does authoritative shared game state live?
- For session-based multiplayer, does the normal landing page list joinable sessions and support create/join?
- Can a Nexus-provided display name be used as presentation/default text without becoming the game's seat/reconnect identity?
- What happens when a phone reloads or temporarily loses the network?
- Can current state be recovered without the previous connection surviving?
- Can the complete game be played without a dedicated display?
- Does `SIGTERM` graceful shutdown release listeners, helpers, and the assigned port on Linux?
- Are browser storage/cookies scoped sensibly?
- Does the game need outbound internet access or unusual host capability?
- Can the runtime operate within the measured resource/proxy ceilings of supported deployment profiles?
- Which checks belong in the reusable Nexus seam tests versus the game's own verifier?

## Compatibility tests worth planning early

A reusable Nexus compatibility harness should eventually establish at least:

- startup with non-default `HOST`, `PORT`, and `BASE_PATH` environment values;
- binding to the assigned private `HOST`/`PORT` rather than widening exposure;
- fixed private `/__nexus/status` readiness behavior, including valid `ready=false` and invalid/unavailable status handling;
- public rejection of `/games/<id>/__nexus/status` and encoded/canonicalization variants that could resolve into the reserved management namespace;
- unchanged successful routing for ordinary game paths that do not enter the reserved management namespace;
- initial HTML load at `BASE_PATH/`;
- correct `BASE_PATH` stripping to private runtime routes;
- static assets beneath `BASE_PATH` when used;
- same-origin API traffic beneath `BASE_PATH`;
- WebSocket/SSE routing when used;
- HTTPS/WSS compatibility through the Nexus proxy;
- redirect/generated-link base-path safety;
- service-worker scope containment when used;
- browser-artifact exposure/static-root containment when filesystem static serving is used;
- `SIGTERM` graceful shutdown and port release on Linux.

Game-specific verification should establish the behavioral requirements Nexus cannot generically understand, including:

- session/room landing-page behavior when applicable;
- Nexus display-name handoff behavior once that optional profile seam is defined;
- reconnect/current-state recovery;
- server-authoritative game behavior;
- complete TV-less play.

The reusable harness should verify the integration seam, not game rules.

The goal is a strict, maintainable platform seam without turning Nexus into a generic tabletop-game engine.
