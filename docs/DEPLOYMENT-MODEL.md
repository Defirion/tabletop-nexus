# Nexus Deployment Model

**Status:** Draft architecture decision  
**Scope:** Resource/deployment assumptions for Tabletop Nexus and remote play  

This document records deployment constraints that should remain true regardless of hosting provider. It does not declare any specific cloud/free-tier instance supported yet.

## Decision

Tabletop Nexus targets an **ordinary Linux VM or equivalent host environment**, not a provider-specific runtime.

The initial remote-play operating model assumes:

- Nexus is long-lived;
- Tailscale and `cloudflared` may be long-lived alongside it;
- Nexus launches and supervises game processes;
- game processes bind to Nexus-selected private ports;
- supported remote play runs game code under a security identity/sandbox that is distinct from Nexus and cannot reach Nexus control-plane listeners merely because it is local to the VM;
- on a supported cloud profile, that game execution context also cannot obtain usable provider/host credentials or sensitive control data from metadata, workload-identity, or equivalent local credential endpoints;
- **one game runtime is active at a time** for the initial supported deployment profile;
- the host/VM has enough headroom for the operating system, ingress/control services, Nexus, and that one game.

The same Nexus/game contract should work whether the Linux VM is:

- a VM on the owner's physical computer;
- a small cloud VM;
- another conventional Linux host that satisfies the same network/process assumptions.

Provider-specific behavior must not leak into `GAME-CONTRACT.md` or game code.

## Why one active game initially

Nexus is a board-game launcher rather than a general multi-tenant game hosting service. For the intended household/friends use, only the selected game normally needs to be running.

The initial resource shape is therefore:

```text
Linux VM / host
├── OS + basic services
├── Tailscale
├── cloudflared (when remote play is enabled)
├── Nexus
└── one active game runtime
```

Switching games should release the old game's resources before the next game is considered ready.

This makes low-resource hosting easier to reason about and limits one source of accidental resource exhaustion without requiring containers or a larger orchestration system.

Multiple simultaneously running games are a future capability, not an assumption other design work should depend on.

## Resource support is measured, not guessed

Do not encode a minimum VM size based only on provider marketing labels.

A deployment profile becomes supported only after measuring representative usage for:

1. operating system baseline;
2. Tailscale and `cloudflared` baseline;
3. idle Nexus;
4. Nexus under ordinary proxy/portal load;
5. each supported game at realistic/peak table activity;
6. safe headroom for transient spikes and maintenance tasks.

Useful measurements include:

- resident memory;
- peak memory;
- CPU utilization and sustained CPU pressure;
- process/task count;
- file-descriptor/socket usage;
- startup time;
- network traffic during normal play.

A small/free-tier VM may be an excellent deployment target, but it should be documented as a **tested profile** only after those measurements pass with headroom.

## Portability invariant

Nexus should depend on host capabilities, not host brands.

Expected host capabilities are conceptually:

```text
Linux process execution
loopback/private TCP
ordinary filesystem permissions
outbound internet connectivity where remote ingress/control requires it
sufficient CPU/RAM for Nexus + one game
```

Supported remote play additionally requires the host to be able to launch/supervise the game under a distinct security identity or equivalent sandbox and to enforce host-local access controls that keep the game away from Nexus player-ingress and admin control surfaces.

For a supported cloud-hosted profile, those host capabilities must also let the deployment prevent the game-runtime context from obtaining usable provider/host credentials or sensitive control data through metadata, workload-identity, or equivalent local credential surfaces. The required property is provider-independent; the concrete mechanism belongs to the deployment profile.

Remote play may additionally use Tailscale and Cloudflare Tunnel, but Nexus games should not know which cloud/provider supplies the VM.

Avoid provider-specific dependencies such as:

- serverless function lifecycles;
- proprietary request/event invocation models;
- provider-only databases as a Nexus runtime prerequisite;
- provider-injected game configuration;
- provider-specific URL generation inside games.

## Long-lived process requirement

The Nexus architecture is deliberately different from request-scoped/serverless hosting.

Nexus needs to be able to:

```text
start game
  |
wait for Nexus readiness
  |
proxy players for the duration of play
  |
observe lifecycle
  |
stop game
```

A deployment platform is suitable only if it can provide that process/lifecycle model or emulate it without changing the Nexus/game contract.

If a future game is redesigned specifically for a serverless/cloud-native platform, that may be useful independently, but it should not force the core Nexus runtime away from the ordinary-process model without a separate architecture decision.

## Home VM and cloud VM are deployment variants

The network edges differ, but the inner architecture should remain the same.

### Home-hosted

```text
physical host
   |
Linux VM
   ├── Tailscale
   ├── cloudflared
   ├── Nexus
   └── active game
```

The physical host is the outer containment boundary.

### Cloud-hosted

```text
cloud provider
   |
Linux VM
   ├── Tailscale
   ├── cloudflared
   ├── Nexus
   └── active game
```

The cloud VM replaces the home VM but should not change the game integration seam.

Cloud hosting adds one deployment-local trust surface that a home profile may not have: provider metadata, attached service/workload identity, instance bootstrap/user-data, or equivalent host-local credential/control endpoints. A cloud profile is not supported merely because the game has a different Unix identity; the game execution context must also be unable to turn those local services into usable authority or sensitive control data outside the intended game-runtime boundary.

## Network assumptions

The intended remote architecture remains:

```text
player browser
   |
HTTPS / WSS
   |
Cloudflare edge/tunnel
   |
Nexus player ingress
   |
private game port
```

Administration remains a separate private path through Tailscale.

No deployment profile should require exposing game ports directly to the internet or router port-forwarding to Nexus/game processes.

Ordinary public-internet egress, when allowed, does **not** imply access to provider/host-local credential services. A supported cloud profile must separately account for metadata/workload-identity endpoints and equivalent local agents or sockets reachable from the game context.

Detailed remote-play security controls remain in `docs/REMOTE-PLAY.md`.

## Resource isolation

The VM/host resource limit and one-active-game policy are not sufficient by themselves to protect Nexus availability from a runaway child process.

Supported remote deployment should still use proportionate game-process limits for memory/CPU/tasks/file descriptors as described in the remote-play plan.

The layers have different purposes:

```text
host/VM limit
    protects the outer machine/account

per-game limit
    protects Nexus/cloudflared availability inside the VM

one-active-game policy
    keeps normal resource budgeting simple
```

None of these initially requires containers.

## Local control-plane isolation for supported remote play

A game runtime is intentionally reachable from hostile public player traffic, so an ordinary dependency exploit in that runtime must not implicitly grant Nexus process-control authority merely because both processes share one VM.

For supported remote play:

- the active game must execute under an OS security identity or equivalent sandbox distinct from Nexus and `cloudflared`;
- the launch/supervision mechanism must apply that boundary even though Nexus initiates lifecycle actions;
- game code must be unable to open the trusted Nexus player Unix socket;
- game code must be unable to connect to the Nexus admin listener/control plane from the local host;
- the boundary must still permit the assigned private game listener, Nexus-to-game traffic, and any explicitly allowed ordinary public-internet egress.

A direct child that retains Nexus's effective OS identity is therefore **not sufficient for supported remote play** when filesystem/socket permissions or local-process identity are being used as security controls. An implementation may use a service manager, a dedicated launcher, systemd sandboxing, a container, or another provider-independent mechanism, but the required property is isolation of the game execution context rather than any one product.

Browser-only admin defenses such as CSRF, Host validation, and frame denial remain necessary for browser threats, but they do not replace this local-process boundary.

## Cloud-local credential isolation for supported cloud profiles

A distinct Unix user or sandbox does not by itself constrain network-reachable metadata or workload-identity services. On a cloud VM, a compromised game runtime must not be able to exchange its allowed network access for provider/account authority or sensitive host control data.

For every supported cloud profile:

- inventory provider/host-local metadata, workload/service-identity, credential-agent, bootstrap/user-data, and equivalent control-data surfaces that could be reachable from the VM;
- the actual game-runtime identity/sandbox must be unable to obtain usable access tokens, keys, signed identity material, bootstrap secrets, or other sensitive control data from those surfaces;
- the invariant must hold across the relevant direct IPv4, IPv6, DNS/hostname, proxy/redirect, loopback/link-local, and provider-specific aliases or transports used by that profile;
- if the VM deliberately has an attached service/workload identity for Nexus, ingress, backup, or other host functions, its credential path must remain unavailable to the game context or otherwise constrained so game compromise cannot acquire authority outside the intended runtime boundary;
- explicitly allowed ordinary public-internet egress must continue to work as a positive control, so the support property is not satisfied merely by disabling all networking.

A profile may satisfy this invariant by attaching no usable service identity, disabling or restricting metadata/credential delivery, isolating those endpoints from the game network/sandbox, or another provider-appropriate mechanism. Nexus architecture does not prescribe one cloud vendor's control.

The support check must be executed from the same security identity/sandbox used by the real game runtime. It must verify the deny/no-credential property for the concrete profile's relevant endpoint forms rather than assuming a generic Unix identity boundary covers them.

## Lifecycle expectation when switching games

The normal sequence is:

```text
Game A running
      |
host requests Game B
      |
Game A graceful stop
      |
forced fallback if necessary
      |
port/process resources released
      |
Game B start
      |
Nexus readiness confirmed
      |
Game B exposed as playable
```

The exact UX for switching games belongs to later Nexus lifecycle/portal work.

For the initial model, Nexus should not silently keep old games resident merely to make switching faster if that undermines the one-active-game resource assumption.

## Persistence

Stopping a game process does not necessarily mean deleting its data.

Each game owns its persistence model. If a game requires durable state between launches, that state should live outside ephemeral process memory in a location the game/Nexus deployment deliberately preserves.

Nexus does not need a universal game database to support the one-active-game model.

## Hosting profiles

Keep provider profiles separate from the architecture contract.

A future deployment guide may contain entries such as:

```text
Profile: Home Linux VM
Status: supported/tested
CPU/RAM: <measured>
Notes: <network/hypervisor details>

Profile: Small cloud VM
Status: experimental/tested/supported
CPU/RAM: <measured>
Service identity/metadata posture: <none/isolated/restricted and how verified>
Bandwidth/storage caveats: <provider-specific>
```

That allows a provider/free-tier offering to change without changing Nexus architecture.

## Acceptance criteria for a deployment profile

Before advertising a concrete VM profile as supported:

- [ ] Nexus, Tailscale, and remote ingress can remain healthy for a full game session.
- [ ] One representative supported game can run at realistic maximum player count.
- [ ] Peak memory leaves deliberate headroom.
- [ ] Sustained CPU is acceptable and does not routinely starve Nexus/ingress.
- [ ] Game-process resource limits do not break legitimate play.
- [ ] Starting/stopping/switching releases expected resources.
- [ ] Private game ports remain private.
- [ ] From the game-runtime execution context, attempts to open trusted player ingress or connect to Nexus administration fail, while the assigned game listener still works.
- [ ] For a cloud-hosted profile, from the real game-runtime execution context, relevant IPv4/IPv6/DNS/provider-local metadata, workload-identity, credential-agent, and equivalent endpoint forms do not yield usable provider/host credentials or sensitive control data.
- [ ] Explicitly allowed ordinary public-internet egress still works as a positive control after the cloud-local credential isolation is applied.
- [ ] Remote-play security acceptance criteria applicable to that deployment pass.
- [ ] Provider-specific bandwidth/storage limits and credential/metadata posture are documented separately.

## Future decision triggers

Revisit the one-active-game assumption if:

- multiple unrelated tables must play simultaneously;
- background game persistence requires running processes;
- startup latency becomes unacceptable and measurement justifies warm runtimes;
- Nexus becomes a shared hosted service rather than a personal/friends deployment.

Revisit the ordinary-VM target if:

- a compelling deployment environment cannot provide process supervision/private ports;
- most games move to a common cloud-native execution model;
- maintaining the VM becomes a larger burden than the portability benefit.

Any such change should be treated as an architecture change, not introduced as a game-specific shim.

## Guiding rule

**Nexus deploys to capabilities; games integrate with Nexus; neither should integrate with a cloud provider by accident.**
