# Remote Play & Security Architecture

**Status:** Proposed architecture and support gate  
**Scope:** Friends-only remote play over the public internet  
**Primary threat model:** Opportunistic bots, scanners, malformed clients, scripted abuse, and ordinary dependency vulnerabilities  

This document records intended remote-play architecture. It does not claim that remote play is implemented. `AGENTS.md`, `docs/PLAN.md`, `docs/ARCHITECTURE.md`, `GAME-CONTRACT.md`, and merged PR state remain authoritative for current behavior.

## 1. Product goal

The target experience is deliberately low-friction:

1. The host reaches Nexus administration privately through Tailscale.
2. The host shares one stable HTTPS Nexus URL or QR code.
3. Friends open it in an ordinary browser with no VPN, account, OTP, or special client.
4. The host starts a game from the private admin surface.
5. Nexus launches the game on a private port and exposes it through the player proxy.
6. Players choose the running game; the game owns its own room/lobby semantics.
7. Nexus provides approximate connection visibility, abuse signals, idle shutdown, and a fast public-ingress kill switch.

The initial service is for trusted friends, not hostile multi-tenant hosting.

## 2. Confirmed decisions

### 2.1 Threat target

Design for hostile public HTTP/WebSocket traffic, including:

- scanners and bots;
- invalid route enumeration;
- malformed/oversized HTTP requests;
- path traversal and header/Host spoofing;
- abusive request/connection rates;
- malformed WebSocket upgrades and message floods;
- long-lived/slow connection exhaustion;
- normal vulnerabilities in trusted game/runtime dependencies.

Installed games are trusted code selected by the host. They are not treated as malicious tenants in the initial design. That trust does **not** mean a game process compromised through a dependency exploit may reach Nexus control-plane authority; the local runtime boundary below remains required.

### 2.2 VM and process isolation

A dedicated Linux VM is the primary physical-host blast-radius boundary. Give the VM explicit CPU/RAM limits.

Containers are **not mandatory** for initial support. The lightweight supported-remote baseline is:

- `cloudflared`, Nexus, and the game runtime execute under separated unprivileged security identities or an equivalent sandbox boundary;
- the game launch/supervision mechanism applies that separation even though Nexus initiates lifecycle actions;
- game processes cannot open the trusted Nexus player-ingress socket;
- game processes cannot connect to the Nexus admin listener/control plane from the local host;
- games do not inherit/read `cloudflared` credentials;
- per-game/process CPU, memory, task/process, and file-descriptor limits exist;
- graceful stop, forced stop, and crash-loop suppression exist.

A direct child that retains Nexus's effective OS identity is not sufficient for supported remote play when local filesystem/socket identity is part of the security boundary. A service manager, dedicated launcher, sandbox, container, or another provider-independent mechanism may enforce the separation; the required property is that code executing in the game-runtime context cannot use Nexus's local privileges.

VM-only limits protect the physical host but do not prevent one runaway or compromised game from starving or controlling Nexus inside the VM, hence both resource limits and control-plane isolation are required.

Rootless containers or stronger systemd sandboxing remain optional implementation choices; containers are not mandatory so long as the required isolation properties are actually enforced.

### 2.3 Zero-friction players

Ordinary players are **not authenticated** by Nexus or Cloudflare Access in the initial design.

The public URL is intentionally easy to share and anyone who learns it can reach the public player portal. Expected-player monitoring and rate controls are compensating visibility/abuse controls, not identity.

If a game needs private rooms, join codes, host admission, or random room IDs, that remains the game's responsibility.

### 2.4 Private administration

Tailscale is the initial admin identity/network boundary. Configure explicit Tailscale grants/ACLs for the intended administrator identity/device(s); do not rely on broad default tailnet reachability.

The public Cloudflare route must never expose process-control or admin endpoints.

Because public traffic intentionally reaches game runtimes on the same VM, Tailscale alone is not the whole local boundary: the game-runtime execution context must also be unable to connect to the Nexus admin listener. Browser CSRF/Host/frame protections do not authenticate a raw local process and cannot substitute for that host-local isolation.

No separate Nexus admin login is required initially, but the admin HTTP surface still requires browser-layer defenses:

- strict expected-Host validation;
- HTTPS over the private/Tailscale browser path where practical;
- CSRF protection on every state-changing action;
- SameSite handling for any admin browser state;
- frame denial (`frame-ancestors 'none'` or equivalent);
- generic error responses;
- structured admin-action audit events.

Add application-layer admin authentication if the admin population/tailnet grows or the threat model changes.

### 2.5 Public URL and shared origin

Use the existing path model:

```text
https://play.example.com/
https://play.example.com/games/<game-id>/
```

This preserves `BASE_PATH` and R2's `/games/<id>/` design.

Games share one browser origin and are therefore mutually trusted at the browser-origin level. Games should:

- namespace browser storage;
- avoid origin-wide cookies;
- scope cookies to `BASE_PATH` where practical;
- avoid service workers unless necessary;
- never allow a service worker to control the Nexus portal or sibling game paths.

Nexus-owned portal/admin pages should use a strong Nexus-owned CSP and security headers. Nexus should not impose one restrictive CSP on all proxied games because their legitimate needs differ. Per-game subdomains remain a future hardening option.

### 2.6 Invitation and rooms

The initial invitation is the stable Nexus URL, not a secret or per-game bearer URL:

```text
https://play.example.com/
```

Nexus should provide **Copy invite link** and **Show QR code**. The QR encodes the same canonical HTTPS URL.

The host starts games privately. Players use the public portal to enter a running game. Games create/manage rooms themselves.

### 2.7 Idle shutdown

Games are manually started through the private admin plane and may be automatically stopped after configurable inactivity.

Idle shutdown is lifecycle convenience, **not a security boundary**. Rejected/probing traffic must not reset the timer. Nexus may count valid proxied traffic/established streams according to a game-agnostic policy, but it must not inspect game semantics to decide whether a user is “really playing.”

### 2.8 Logging / GRC profile

Baseline logging is structured events to journald. A later `LOGGING-MONITORING.md` can define an optional Loki/Grafana profile for dashboards, retention, alerts, and GRC-style evidence.

Loki/Grafana must remain optional observability infrastructure, not a gameplay dependency.

### 2.9 Credential handling

**Open decision:** remotely managed vs locally managed Cloudflare Tunnel credentials and the exact storage/rotation mechanism.

Already decided regardless of that choice:

- `cloudflared` runs as a distinct service identity;
- Nexus/games cannot read its runtime credential;
- games do not inherit its environment;
- secrets never enter Git or application logs;
- account-wide Cloudflare management credentials should not reside on the game VM unnecessarily;
- rotation/revocation must be documented;
- public ingress must be disable-able from Cloudflare externally even if the VM is unavailable/untrusted.

Resolve the exact credential model before production Cloudflare deployment.

### 2.10 Egress

Ordinary public-internet egress from the VM is permitted initially. A complex destination-by-destination default-deny policy is not required.

However, game/VM processes should not have unnecessary access to sensitive home-LAN administration surfaces or unrelated Tailscale peers. Prefer a network/firewall/Tailscale configuration that permits normal internet access while denying lateral access to things such as router/NAS admin services, desktop file shares, unrelated tailnet devices, and the Nexus admin listener unless explicitly required by a separately authenticated boundary.

## 3. Target topology

```text
HOST / ADMIN DEVICE
        |
    Tailscale
   explicit grant
        |
        v
+------------------------+
| Nexus admin interface  |
| start/stop/status/logs |
| expected players       |
| remote-play kill       |
+-----------+------------+
            |
            v
+--------------------------------------------------+
|             Dedicated Linux VM                   |
|                                                  |
| Nexus supervisor -> isolated game runtime        |
|                                                  |
| cloudflared -> Nexus player Unix socket          |
+----------------------+---------------------------+
                       |
               outbound tunnel
                       |
                 Cloudflare edge
                       |
                   HTTPS/WSS
                       |
            https://play.example.com/
                       |
                friends' browsers
```

Existing public website hosting can remain separate:

```text
example.com / www.example.com -> GitHub Pages
play.example.com              -> Cloudflare Tunnel -> Nexus VM
```

The domain may remain registered with Spaceship.

## 4. Cloudflare-to-Nexus trust boundary

### 4.1 Supported Linux default: Unix socket

For supported Linux remote play, prefer a permission-controlled Unix socket:

```text
cloudflared
    |
/run/tabletop-nexus/player.sock
    |
Nexus player listener
```

Required properties:

- no player TCP listener exposed to LAN/internet;
- restrictive socket-directory ownership and permissions;
- game processes cannot open the socket, including after code execution inside the game runtime;
- `cloudflared` is the only non-Nexus service allowed to use it.

The game-runtime identity/sandbox must make the socket denial real. If Nexus directly launches a child under the same effective OS identity that owns/opens the socket, ordinary Unix permissions cannot distinguish that child from Nexus and the boundary is not satisfied.

The exclusive local channel is also what allows Nexus to trust selected Cloudflare-provided attribution headers.

### 4.2 Loopback fallback

Loopback TCP may be used for development or a documented exception, but it is not automatically equivalent to the exclusive socket because other local processes may connect.

If used for supported deployment, add compensating local access controls or downgrade trust in proxy-provided attribution headers.

## 5. Public/player boundary

Expose only intended player functionality, conceptually:

```text
/                       player portal
/api/games              safe public game/lifecycle metadata
/games/<registered-id>/* reverse proxy to running game, except reserved management paths
```

The safe public game API may continue to describe configured/registered games, but the public surface must not expose start/stop/process controls. Player UI must clearly distinguish unavailable games from player-routable ones, and a game route becomes enterable only after Nexus readiness says the runtime may receive players.

Never expose through the public route:

```text
/admin/*
/api/admin/*
/games/<id>/__nexus
/games/<id>/__nexus/*
runtime command/args
filesystem paths/config
sensitive logs
arbitrary process control
```

`/__nexus` is the reserved private runtime-management namespace after the game `BASE_PATH` is removed. The player proxy must never forward a request whose canonical post-prefix target is exactly `/__nexus` or begins `/__nexus/`. This keeps `GET /__nexus/status` and any future management surface private even though ordinary game routes use prefix stripping.

## 6. R2 proxy hardening requirements

These are part of remote-play support even if implementation lands after the basic R2 transport behavior.

### 6.1 Route and path validation

- `<game-id>` must resolve to an actual registered game.
- Never derive arbitrary backend destinations from untrusted path text.
- Canonicalize/validate URL paths before proxying and use one well-defined path interpretation for routing/security decisions.
- Reject escaped/ambiguous traversal such as `..`, encoded `..`, and other forms that could escape `/games/<id>/`.
- After canonicalization and removal of `/games/<id>`, reject targets equal to `/__nexus` or beneath `/__nexus/`; the reserved management namespace is never player-proxyable.
- Encoded namespace characters/separators, dot-segment forms, duplicate-separator forms, or other ambiguous encodings that could resolve into the reserved namespace must fail closed rather than reaching the game.
- Regression coverage must include the exact public `/games/<id>/__nexus/status` path and encoded/canonicalization variants, plus unchanged controls proving ordinary routes such as the game root and normal API/WS paths still proxy successfully.
- The private Nexus-to-game readiness poll to `GET /__nexus/status` remains a positive control and must continue to work directly on the assigned private game host/port.

### 6.2 Host validation

- player listener accepts only the configured public hostname(s);
- admin listener accepts only its configured private hostname(s);
- Host values do not control backend selection or untrusted redirect generation.

Admin Host validation is required even on Tailscale to reduce malicious-browser/DNS-rebinding-style exposure.

### 6.3 Forwarded headers and client attribution

Strip/replace untrusted copies of proxy/internal headers before forwarding to games.

Potentially sensitive headers include:

```text
Forwarded
X-Forwarded-For
X-Forwarded-Host
X-Forwarded-Proto
CF-Connecting-IP
CF-Ray
```

Use one canonical client-attribution source for rate/security telemetry.

When the request arrives through the exclusive `cloudflared` Unix socket, `CF-Connecting-IP` may be treated as trusted public client attribution. If other local processes can reach the listener, that trust no longer follows automatically.

Do not blindly parse arbitrary `X-Forwarded-For` chains as enforcement identity.

### 6.4 HTTP limits and framing

Define/calibrate limits for:

- header size;
- request body size;
- header/request/idle timeouts;
- concurrent connections;
- per-source and per-route request rates.

Use the standard hardened HTTP stack rather than a custom parser. Regression tests must cover malformed/ambiguous framing, including conflicting `Content-Length` / `Transfer-Encoding` and malformed chunked requests.

### 6.5 WebSockets

- proxy upgrades only for registered game routes;
- validate browser `Origin` against the public origin;
- cap connections and message/frame sizes;
- implement backpressure;
- support/test heartbeat and reconnect behavior.

`Origin` validation prevents browser CSWSH-style attacks; it is **not authentication** and scripted clients can forge it.

WebSocket compression should default to disabled through Nexus unless a selected implementation/game demonstrates a need and bounded behavior.

### 6.6 SSE/streaming

Verify long-lived streams, cleanup on disconnect, reconnect behavior, and connection limits.

### 6.7 Safe failure responses

- Nexus-down while tunnel remains up -> generic unavailable/502-style response, no socket/stack detail.
- game-down while Nexus remains up -> controlled game-unavailable response, no backend details.

## 7. Expected-player and anomaly monitoring

The host should be able to answer quickly:

```text
Expected tonight:     4
Approx. active clients: 4
Status:               normal
```

### 7.1 Preserve the game boundary

Nexus monitors transport activity, not authoritative in-game player membership. It may observe registered route activity, connections, streams, and approximate browser presence, but it must not learn room/game rules.

`players.max` provides context; the admin may also supply an expected player count for the current gathering.

### 7.2 Presence telemetry is not identity

Nexus may issue a random client-presence cookie to de-duplicate ordinary browser traffic for the dashboard. It grants no access and must not drive security decisions by itself.

Bots can omit/rotate cookies and privacy browsers may clear them. Abuse controls must continue to work without the cookie.

### 7.3 Multi-signal anomaly model

Combine signals such as:

- approximate presence IDs;
- trusted apparent client IP when the ingress boundary permits it;
- per-route request rate;
- WebSocket count/churn;
- SSE count;
- invalid/unregistered route rate;
- malformed upgrade/request rate;
- size-limit violations;
- sudden traffic growth for one game route.

Example escalation:

- **Normal:** expected traffic.
- **Notice:** approximate active clients exceed expected count; log/show warning.
- **Suspicious:** large deviation, repeated invalid routes, abnormal connection/request rate; warn and throttle where appropriate.
- **Active abuse:** sustained flood/exploit-like traffic or resource pressure; terminate/throttle and use kill switch if needed.

This is lightweight application-layer anomaly detection, not a full IDS.

## 8. Edge abuse protection

Cloudflare is the public traffic shield, not the player identity provider in this mode.

Use available edge protections where useful, including DDoS controls, rate limiting, WAF/bot controls, and cache policy. Dynamic Nexus/API routes must not be accidentally cached.

Edge rules must be tested against legitimate mobile browsers, WebSocket upgrades, reconnects, and normal game traffic.

## 9. VM/network and game binding

High-level desired network state:

```text
Public inbound to VM:                    none
Cloudflare:                              outbound tunnel
Tailscale:                               explicit admin-only access
Nexus -> game ports:                     local/private
Game ports -> LAN/internet:              unreachable
Game runtime -> Nexus player socket:     denied
Game runtime -> Nexus admin listener:    denied
VM/games -> sensitive LAN/Tailscale:     denied unless required
VM/games -> ordinary public internet:    allowed initially
```

Verify IPv4 **and IPv6**.

Games receive `HOST`, `PORT`, and `BASE_PATH` and must honor the assigned private bind host. A game that cannot bind privately must be rejected for supported remote play or wrapped by deployment-level enforcement before use.

The local-isolation checks must be executed from the same security identity/sandbox used by the real game runtime. Positive controls should prove that Nexus can still reach the assigned game listener, `cloudflared` can still open the player socket, the intended administrator can still reach the admin listener over the private path, and the game retains explicitly allowed ordinary internet egress.

## 10. Browser/HTTPS security

Remote play must verify secure-context behavior on representative mobile browsers, including motion/orientation permissions and user-gesture requirements for games that use them.

Also verify WSS, reconnect behavior, background/resume behavior where relevant, and QR navigation.

Nexus-owned portal/admin pages should set a strong baseline appropriate to their own content, including as applicable:

- `X-Content-Type-Options: nosniff`;
- restrictive Nexus-owned CSP;
- frame denial for admin;
- sensible Referrer-Policy;
- narrow Permissions-Policy;
- non-cacheable handling for dynamic/admin/API responses;
- HSTS once the HTTPS public hostname is stable and ready for that commitment.

Do not impose one restrictive game CSP centrally. Service workers, if used by a game, must remain scoped beneath its own `BASE_PATH`.

Public errors must not expose filesystem paths, socket names, child command lines, or stack traces.

## 11. Logging and GRC artifacts

Baseline structured events should cover at least:

- game start/started/start-failed/idle/stop/force-stop/crash/crash-loop;
- expected-player and idle-timeout changes;
- remote-play enabled/disabled;
- invalid route/path/Host/WS-origin events, including attempts to enter the reserved runtime-management namespace through player routing;
- size/rate/connection-limit events;
- client-count/anomaly warnings.

Do not log tunnel tokens, cookies unnecessarily, full sensitive headers, or game payloads.

Proposed companion artifacts:

```text
THREAT-MODEL.md
DEPLOYMENT-HARDENING.md
LOGGING-MONITORING.md
INCIDENT-RESPONSE.md
```

`LOGGING-MONITORING.md` may define an optional journald -> Loki -> Grafana profile for dashboards/alerts/evidence.

## 12. Operations and kill switches

Document reasonable patch/update handling for the Linux VM, Node/Nexus, Tailscale, `cloudflared`, and installed games. Keep VM time synchronized and back up configuration/persistent game state required to rebuild.

Use MFA and sound account hygiene on infrastructure control accounts (Cloudflare, Tailscale, registrar/DNS provider, GitHub) where available.

### 12.1 Local kill switch

A host-level action such as stopping/disabling `cloudflared` must sever public ingress without stopping Tailscale administration.

### 12.2 External kill switch

A separate trusted device must be able to disable the public Cloudflare tunnel/route from Cloudflare's control plane even if Nexus/VM/Tailscale access is unavailable or the VM is suspected compromised.

Suggested incident sequence:

1. disable public ingress;
2. retain private admin access only if the VM remains trusted;
3. stop affected games;
4. inspect logs;
5. rotate credentials if indicated;
6. restore ingress only after the issue is understood/mitigated.

## 13. Accepted risks / deliberately deferred complexity

Accepted for the initial friends-only mode:

- trusted installed games rather than hostile tenants, while still containing ordinary game/runtime compromise away from Nexus control-plane authority;
- no mandatory containers;
- ordinary public-internet egress;
- no mandatory player identity;
- anyone with the stable URL can reach the public portal;
- game-specific room privacy is game-owned;
- one shared browser origin;
- no enterprise SIEM/IDS;
- no second Nexus admin MFA/login;
- no secret/session invite URLs.

Do not make these mandatory without a changed threat model:

- Kubernetes;
- per-game containers;
- separate `cloudflared` VM;
- service mesh;
- enterprise secrets manager;
- mandatory Loki/Grafana;
- player accounts/OTP;
- complex destination-by-destination internet-egress allowlists;
- per-game subdomains.

## 14. Credential decision gate

Before production Cloudflare work, decide and document:

1. remotely managed vs locally managed tunnel;
2. runtime credential form/location;
3. file/service ownership and permissions;
4. rotation/revocation procedure;
5. exact external disable/kill procedure;
6. whether any Cloudflare management credential is ever present on the VM.

This remains intentionally **undecided** until that discussion occurs.

## 15. Implementation sequence

### Phase A — existing R1

1. Finish process supervision.
2. Supply `HOST`, `PORT`, `BASE_PATH`.
3. Migrate configurable `runtime.healthPath` to the fixed private `/__nexus/status` readiness contract atomically with contract/schema, validator, and tests; then add Nexus readiness/lifecycle polling.
4. Add graceful/forced shutdown and enforce the initial one-active-game policy.
5. Complete lifecycle tests.

### Phase B — R2 and proxy hardening

6. Implement HTTP reverse proxy, WS upgrades, SSE, registered-route rejection, and end-to-end tests.
7. Add path and Host validation, including fail-closed rejection of the reserved `/__nexus` runtime-management namespace after canonicalization/prefix removal.
8. Add regressions for exact, encoded, and canonicalization variants of `/games/<id>/__nexus/status`, with normal game routes and direct private readiness polling retained as positive controls.
9. Add forwarded-header/client-attribution policy.
10. Add HTTP size/time/connection limits and framing regressions.
11. Add WS Origin/message/connection/backpressure behavior and default-off compression policy.
12. Add safe backend-down responses.

### Phase C — local security boundary

13. Separate admin/player interfaces.
14. Establish the game-runtime execution boundary: supported remote play runs games under a distinct OS security identity/sandbox and denies that context both the player Unix socket and the local Nexus admin listener.
15. Add admin CSRF/frame/Host protections.
16. Add supported Unix-socket player ingress and verify permissions against the actual game-runtime identity.
17. Establish VM CPU/RAM and game process limits.
18. Separate `cloudflared`/Nexus/game privilege and credential visibility.
19. Configure Tailscale admin grants.
20. Restrict unnecessary access to sensitive LAN/tailnet peers.

### Phase D — public ingress

21. Resolve Cloudflare credential decision.
22. Configure Tunnel to the player socket only.
23. Verify no game/admin public or LAN exposure over IPv4/IPv6.
24. Bind trusted client attribution to the exclusive ingress path.
25. Configure/test edge rate/cache behavior.
26. Implement/test local and external kill switches.

### Phase E — visibility and UX

27. Add expected-player setting and approximate presence telemetry.
28. Add route/IP/connection-rate anomaly signals independent of cookies.
29. Add structured warnings and safe throttling.
30. Add stable invite URL, copy link, and QR.
31. Verify no-login friend join and game-owned rooms.
32. Add configurable idle shutdown.

### Phase F — assurance

33. Verify browser secure-context features and WS/SSE through Cloudflare.
34. Verify admin CSRF/Host behavior from hostile browser contexts.
35. Verify HTTP framing, path, Host, header, and WS protections, including reserved-management path rejection.
36. Verify IPv4/IPv6/LAN/tailnet boundaries.
37. From the real game-runtime execution context, verify both trusted player ingress and the Nexus admin listener are unreachable while assigned game networking and allowed egress remain functional.
38. Verify credential isolation and generic failure responses.
39. Verify anomaly events and both kill switches.
40. Create companion security/GRC artifacts.
41. Declare remote play supported only after the acceptance gate passes.

## 16. Remote-play support gate

### Network

- [ ] No game port is reachable from internet or unintended LAN paths.
- [ ] Admin is unreachable through player ingress.
- [ ] Supported Linux ingress uses a protected Unix socket or a documented compensated exception.
- [ ] From the actual game-runtime security identity/sandbox, opening the trusted player socket fails.
- [ ] From the actual game-runtime security identity/sandbox, connecting to the Nexus admin listener/control plane fails.
- [ ] Positive controls confirm Nexus can reach the assigned game listener, `cloudflared` can reach player ingress, intended Tailscale administration still works, and explicitly allowed game egress still works.
- [ ] Explicit Tailscale admin grants exist.
- [ ] Sensitive LAN/unrelated tailnet reachability is restricted.
- [ ] IPv4 and IPv6 boundaries are verified.
- [ ] No router port forwarding is required.

### Proxy

- [ ] Only registered game IDs route.
- [ ] Escaped/ambiguous traversal variants are rejected.
- [ ] `/games/<id>/__nexus/status` is rejected by player routing and never reaches the game management endpoint.
- [ ] Encoded/canonicalization variants that could resolve to `/__nexus` or `/__nexus/*` fail closed.
- [ ] Normal game-root/API/WS routes remain routable as unchanged controls, and direct private Nexus readiness polling still works.
- [ ] Player and admin Host policies work.
- [ ] Forwarded headers/client attribution follow the trusted-ingress policy.
- [ ] Body/header/connection/time limits exist.
- [ ] Conflicting CL/TE and malformed framing tests pass safely.
- [ ] WS Origin validation, message limits, connection limits, and backpressure exist.
- [ ] WS compression is disabled by default or explicitly bounded/tested.
- [ ] SSE cleanup/reconnect is tested.
- [ ] Nexus-down/game-down responses are generic and leak no internals.

### Admin/runtime

- [ ] Admin state-changing actions are CSRF-protected and not frameable.
- [ ] Admin action audit events exist.
- [ ] The supported remote game launch path does not leave the game under Nexus's effective OS security identity unless an equivalent sandbox/application-auth boundary independently enforces both local deny rules.
- [ ] VM CPU/RAM and game process limits exist.
- [ ] `cloudflared`, Nexus, and games have separated privilege/credential visibility.
- [ ] Tunnel credentials are unreadable to Nexus/game processes.
- [ ] Graceful/forced stop and crash-loop controls work.

### Players/monitoring

- [ ] Stable HTTPS invite and QR work without Tailscale/account/OTP.
- [ ] Game-owned room behavior works.
- [ ] Admin can set expected players and see approximate active clients.
- [ ] Presence IDs are non-authoritative telemetry only.
- [ ] Abuse controls still work when cookies are absent/rotated.
- [ ] Route/IP/connection-rate anomalies generate visible/logged events.
- [ ] Legitimate reconnects do not routinely false-alarm.

### Browser/operations

- [ ] HTTPS secure context, WSS, and required mobile motion permissions are verified.
- [ ] Nexus portal/admin baseline headers are verified.
- [ ] Service workers cannot escape intended scope.
- [ ] Cloudflare credential storage/rotation decision is implemented/documented.
- [ ] Logs omit secrets.
- [ ] Patch/update handling is documented.
- [ ] Local `cloudflared` stop and external Cloudflare kill switch are tested from separate control paths.

## 17. Future decision triggers

Revisit this architecture if any of these become true:

- arbitrary third-party games are installable;
- Nexus becomes broadly/publicly advertised;
- users gain persistent accounts or sensitive data;
- multiple unrelated groups share one Nexus;
- paid hosting is offered;
- game repositories cannot be treated as trusted;
- public abuse makes zero-auth access impractical.
