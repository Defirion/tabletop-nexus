import { randomBytes } from "node:crypto";

import { PrivatePortAllocator } from "./private-ports.js";
import {
  createLocalGameProcessLauncher,
  launchSupervisedGameProcess,
} from "./process-launcher.js";
import {
  NEXUS_LAUNCH_TOKEN_ENV,
  waitForNexusReadiness,
} from "./readiness.js";

export const GAME_LIFECYCLE_STATUS = Object.freeze({
  CONFIGURED: "configured",
  STARTING: "starting",
  RUNNING: "running",
  STOPPING: "stopping",
  STOPPED: "stopped",
  FAILED: "failed",
});

function assertInstalledGame(game) {
  if (game === null || typeof game !== "object") {
    throw new TypeError("game must be an installed game object");
  }
  if (typeof game.manifest?.id !== "string" || game.manifest.id.trim() === "") {
    throw new TypeError("game.manifest.id must be a non-empty string");
  }
}

function snapshot(state) {
  return Object.freeze({ ...state });
}

function messageFor(error) {
  return error instanceof Error ? error.message : String(error);
}

function defaultLaunchTokenFactory() {
  return randomBytes(32).toString("hex");
}

function createLaunchToken(factory) {
  const launchToken = factory();
  if (typeof launchToken !== "string" || launchToken.length === 0) {
    throw new TypeError("launchTokenFactory must return a non-empty string");
  }
  return launchToken;
}

function stableManifestSignature(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableManifestSignature).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableManifestSignature(value[key])}`
  )).join(",")}}`;
}

function installedGameIdentity(game) {
  if (typeof game.root !== "string" || game.root.length === 0) {
    throw new TypeError("game.root must be a non-empty string");
  }
  // Only fields which determine the running process and its public base path
  // identify an installed runtime. Schema-2 descriptive and extension fields
  // must remain operationally ignored while that runtime is active.
  return `${game.root}\u0000${stableManifestSignature({
    id: game.manifest.id,
    runtime: {
      command: game.manifest.runtime?.command,
      args: game.manifest.runtime?.args,
    },
  })}`;
}

function recoveryError(code, message) {
  return Object.assign(new Error(message), { code });
}

// A background poll must not keep the process alive by itself; a wait that an
// operation is blocked on must.
function sleep(ms, { background = false } = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (background) {
      timer.unref();
    }
  });
}

export class RuntimeSupervisor {
  #allocator;
  #launcher;
  #requireDistinctSecurityBoundary;
  #launchTokenFactory;
  #startupTimeoutMs;
  #pollIntervalMs;
  #requestTimeoutMs;
  #stopGracePeriodMs;
  #journal;
  #logger;
  #recoveryPollMs;
  #recoveryDeadlineMs;
  #blocked = null;
  #active = null;
  #states = new Map();
  #queue = Promise.resolve();

  /**
   * `journal` (optional) persists the ownership evidence of the current runtime
   * so a later Nexus process can tell whether a leftover runtime is provably its
   * own. Without one, lifecycle state is memory-only as before.
   */
  constructor({
    allocator = new PrivatePortAllocator(),
    launcher = createLocalGameProcessLauncher(),
    requireDistinctSecurityBoundary = false,
    launchTokenFactory = defaultLaunchTokenFactory,
    startupTimeoutMs = 30_000,
    pollIntervalMs = 200,
    requestTimeoutMs = 1_000,
    stopGracePeriodMs = 5_000,
    journal = null,
    logger = null,
    recoveryPollMs = 500,
    recoveryDeadlineMs = 15_000,
  } = {}) {
    if (!allocator || typeof allocator.allocate !== "function") {
      throw new TypeError("allocator.allocate must be a function");
    }
    if (!launcher || typeof launcher !== "object") {
      throw new TypeError("launcher must be an object");
    }
    if (typeof requireDistinctSecurityBoundary !== "boolean") {
      throw new TypeError("requireDistinctSecurityBoundary must be a boolean");
    }
    if (typeof launchTokenFactory !== "function") {
      throw new TypeError("launchTokenFactory must be a function");
    }
    if (
      journal !== null
      && (typeof journal.read !== "function"
        || typeof journal.write !== "function"
        || typeof journal.clear !== "function")
    ) {
      throw new TypeError("journal must provide read, write and clear");
    }
    for (const [name, value, allowZero] of [
      ["startupTimeoutMs", startupTimeoutMs, false],
      ["pollIntervalMs", pollIntervalMs, false],
      ["requestTimeoutMs", requestTimeoutMs, false],
      ["stopGracePeriodMs", stopGracePeriodMs, true],
      ["recoveryPollMs", recoveryPollMs, false],
      ["recoveryDeadlineMs", recoveryDeadlineMs, true],
    ]) {
      if (!Number.isFinite(value) || value < (allowZero ? 0 : 1)) {
        throw new TypeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} finite number`);
      }
    }

    this.#allocator = allocator;
    this.#launcher = launcher;
    this.#requireDistinctSecurityBoundary = requireDistinctSecurityBoundary;
    this.#launchTokenFactory = launchTokenFactory;
    this.#startupTimeoutMs = startupTimeoutMs;
    this.#pollIntervalMs = pollIntervalMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#stopGracePeriodMs = stopGracePeriodMs;
    this.#journal = journal;
    this.#logger = logger;
    this.#recoveryPollMs = recoveryPollMs;
    this.#recoveryDeadlineMs = recoveryDeadlineMs;
  }

  getState(gameId) {
    const state = this.#states.get(gameId);
    return state === undefined
      ? snapshot({ gameId, status: GAME_LIFECYCLE_STATUS.CONFIGURED })
      : snapshot(state);
  }

  getActiveRuntime() {
    if (this.#active === null) {
      return null;
    }
    const { gameId, lease, basePath, status, recovered } = this.#active;
    return snapshot({
      gameId,
      host: lease.host,
      port: lease.port,
      basePath,
      status,
      ...(recovered === true ? { recovered: true } : {}),
    });
  }

  /**
   * Non-null while a stored ownership record could not be interpreted at all, so
   * Nexus cannot tell what may still be running and refuses to start anything.
   */
  getRecovery() {
    return this.#blocked === null ? null : snapshot({ status: "blocked" });
  }

  /**
   * Reconciles a runtime left by a previous Nexus process. Call once at startup,
   * before accepting lifecycle requests.
   *
   * A leftover runtime is never adopted or signalled from here. Ownership must
   * be proven by the launcher (process group plus per-launch lifecycle token);
   * the launch-time controller reaps its own group when Nexus disappears. This
   * method only verifies that, and holds the single active slot (and the private
   * port claim) until the runtime is confirmed gone. Anything unverifiable keeps
   * the slot occupied and blocks replacement.
   */
  recover() {
    return this.#enqueue(() => this.#recover());
  }

  acquireActiveRuntime(game) {
    assertInstalledGame(game);
    const record = this.#active;
    if (
      record === null
      || record.status !== GAME_LIFECYCLE_STATUS.RUNNING
      || record.identity !== installedGameIdentity(game)
    ) {
      return null;
    }

    record.proxyReferences += 1;
    let released = false;
    return Object.freeze({
      gameId: record.gameId,
      host: record.lease.host,
      port: record.lease.port,
      release: () => {
        if (!released) {
          released = true;
          this.#releaseProxyReference(record);
        }
      },
    });
  }

  start(game) {
    assertInstalledGame(game);
    return this.#enqueue(() => this.#start(game));
  }

  stop(expectedGameId) {
    return this.#enqueue(() => {
      if (expectedGameId !== undefined && this.#active?.gameId !== expectedGameId) {
        throw Object.assign(new Error("active game changed"), { code: "RUNTIME_CHANGED" });
      }
      return this.#stopActive();
    });
  }

  #enqueue(operation) {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #setState(gameId, status, extra = {}) {
    const recovered = this.#active?.gameId === gameId && this.#active.recovered === true;
    const next = { gameId, status, ...(recovered ? { recovered: true } : {}), ...extra };
    this.#states.set(gameId, next);
    if (this.#active?.gameId === gameId) {
      this.#active.status = status;
    }
    return snapshot(next);
  }

  async #start(game) {
    if (this.#blocked !== null) {
      await this.#recover();
      if (this.#blocked !== null) {
        throw recoveryError(
          "RECOVERY_BLOCKED",
          "a previous Nexus run left runtime ownership that cannot be interpreted",
        );
      }
    }
    if (this.#active !== null) {
      await this.#stopActive();
    }

    const gameId = game.manifest.id;
    const basePath = `/games/${gameId}`;
    this.#setState(gameId, GAME_LIFECYCLE_STATUS.STARTING);

    let lease;
    let record;
    let journalEntry = null;
    try {
      lease = await this.#allocator.allocate();
      const launchToken = createLaunchToken(this.#launchTokenFactory);
      // Write-ahead: the launcher hands over the generation's identity before
      // the runtime is allowed to run, and a failed write aborts the launch.
      const recordOwnership = this.#journal !== null && this.#launcher.recoverable === true
        ? (ownership) => {
          const entry = {
            gameId,
            privatePort: lease.port,
            phase: "launching",
            launchedAt: new Date().toISOString(),
            ownership,
          };
          this.#journal.write(entry);
          journalEntry = entry;
        }
        : undefined;
      const execution = launchSupervisedGameProcess(game, {
        launcher: this.#launcher,
        requireDistinctSecurityBoundary: this.#requireDistinctSecurityBoundary,
        recordOwnership,
        environment: {
          HOST: lease.host,
          PORT: String(lease.port),
          BASE_PATH: basePath,
          [NEXUS_LAUNCH_TOKEN_ENV]: launchToken,
        },
      });
      const exitPromise = execution.waitForExit();
      record = {
        gameId,
        identity: installedGameIdentity(game),
        lease,
        execution,
        exitPromise,
        launchToken,
        basePath,
        status: GAME_LIFECYCLE_STATUS.STARTING,
        released: false,
        proxyReferences: 0,
        resolveProxyReferences: null,
        journalEntry,
      };
      this.#active = record;

      // Install definitive-exit cleanup immediately, not only after readiness.
      // If startup/stop cleanup fails but the process exits later, the retained
      // lease is released only at that confirmed termination point.
      exitPromise.then((exit) => {
        this.#enqueue(() => this.#handleDefinitiveExit(record, exit));
      });

      await waitForNexusReadiness({
        host: lease.host,
        port: lease.port,
        launchToken,
        exitPromise,
        startupTimeoutMs: this.#startupTimeoutMs,
        pollIntervalMs: this.#pollIntervalMs,
        requestTimeoutMs: this.#requestTimeoutMs,
      });

      if (this.#active !== record) {
        throw new Error("game runtime changed during startup");
      }

      this.#setState(gameId, GAME_LIFECYCLE_STATUS.RUNNING);
      this.#noteJournalPhase(record, "running");
      return this.getState(gameId);
    } catch (error) {
      if (record !== undefined) {
        const alreadyExited = error?.code === "GAME_EXITED_BEFORE_READY";
        if (!alreadyExited) {
          try {
            await record.execution.stop({ gracePeriodMs: this.#stopGracePeriodMs });
          } catch (stopError) {
            this.#setState(gameId, GAME_LIFECYCLE_STATUS.FAILED, {
              error: `${messageFor(error)}; cleanup failed: ${messageFor(stopError)}`,
            });
            throw error;
          }
        }
        this.#releaseRecord(record);
      } else {
        // The launch failed after any controller was recorded but before a
        // runtime handle existed; a controller that never started its runtime
        // exits on its own, so the record has nothing left to describe.
        if (journalEntry !== null) {
          this.#clearJournal();
        }
        lease?.release();
      }
      this.#setState(gameId, GAME_LIFECYCLE_STATUS.FAILED, { error: messageFor(error) });
      throw error;
    }
  }

  async #stopActive() {
    const record = this.#active;
    if (record === null) {
      return null;
    }

    this.#setState(record.gameId, GAME_LIFECYCLE_STATUS.STOPPING);
    await this.#waitForProxyReferences(record);

    let stopResult;
    try {
      stopResult = await record.execution.stop({ gracePeriodMs: this.#stopGracePeriodMs });
    } catch (error) {
      this.#setState(record.gameId, GAME_LIFECYCLE_STATUS.FAILED, {
        error: `failed to stop runtime: ${messageFor(error)}`,
      });
      throw error;
    }

    this.#releaseRecord(record);
    this.#setState(record.gameId, GAME_LIFECYCLE_STATUS.STOPPED);
    return snapshot({
      gameId: record.gameId,
      status: GAME_LIFECYCLE_STATUS.STOPPED,
      forced: stopResult.forced === true,
    });
  }

  #releaseRecord(record) {
    if (!record.released) {
      record.released = true;
      // Ownership evidence is dropped only at the confirmed-termination point
      // where the lease is also released.
      if (record.journalEntry !== null) {
        this.#clearJournal();
      }
      record.lease.release();
    }
    if (this.#active === record) {
      this.#active = null;
    }
  }

  #clearJournal() {
    try {
      this.#journal?.clear();
    } catch (error) {
      // A stale record is harmless: the next startup verifies it against the
      // live system and finds the generation absent.
      this.#logger?.warn?.(`could not clear the runtime ownership record: ${messageFor(error)}`);
    }
  }

  #noteJournalPhase(record, phase) {
    if (record.journalEntry === null) {
      return;
    }
    try {
      record.journalEntry = { ...record.journalEntry, phase };
      this.#journal.write(record.journalEntry);
    } catch (error) {
      // Phase is diagnostic only; the ownership evidence is already on disk.
      this.#logger?.warn?.(`could not update the runtime ownership record: ${messageFor(error)}`);
    }
  }

  #readJournal() {
    try {
      return this.#journal.read();
    } catch (error) {
      return { status: "unreadable", reason: messageFor(error) };
    }
  }

  async #recover() {
    if (this.#journal === null || this.#active !== null) {
      return;
    }

    const stored = this.#readJournal();
    if (stored.status === "empty") {
      this.#blocked = null;
      return;
    }
    if (stored.status === "unreadable") {
      if (this.#blocked?.reason !== stored.reason) {
        this.#logger?.warn?.(
          `Nexus cannot interpret its runtime ownership record (${stored.reason}). `
          + "It will not start a game because a previous run may have left one running. "
          + "Check for a leftover game process on this host and stop it, then delete the ownership record "
          + "(the runtime-ownership.json file in the Nexus state directory, NEXUS_STATE_DIR) to continue.",
        );
      }
      this.#blocked = { reason: stored.reason };
      this.#scheduleBlockedRecheck();
      return;
    }
    this.#blocked = null;

    const { entry } = stored;
    const inspection = this.#inspectRecovery(entry);
    if (inspection.state === "absent") {
      this.#logger?.info?.(`No runtime from a previous Nexus run remains for ${entry.gameId}.`);
      this.#clearJournal();
      return;
    }

    const lease = this.#allocator.claim?.(entry.privatePort) ?? Object.freeze({
      host: "127.0.0.1",
      port: entry.privatePort,
      release: () => true,
    });
    const record = {
      gameId: entry.gameId,
      // No installed identity: a leftover runtime is never routable or
      // adoptable, only cleaned up or reported.
      identity: null,
      lease,
      execution: null,
      exitPromise: null,
      launchToken: null,
      basePath: `/games/${entry.gameId}`,
      status: GAME_LIFECYCLE_STATUS.STOPPING,
      released: false,
      proxyReferences: 0,
      resolveProxyReferences: null,
      journalEntry: entry,
      recovered: true,
    };
    record.execution = Object.freeze({
      securityBoundary: this.#launcher.securityBoundary,
      waitForExit: () => record.exitPromise,
      stop: () => this.#awaitRecoveredExit(record, entry),
    });
    this.#active = record;
    this.#setState(entry.gameId, GAME_LIFECYCLE_STATUS.STOPPING);
    this.#logger?.warn?.(
      `A runtime for ${entry.gameId} from a previous Nexus run is still present; `
      + "waiting for its own controller to remove it. Nothing is signalled from this process.",
    );
    // The watcher may report a problem on its first, synchronous inspection, so
    // it starts only after the record and its initial state are in place.
    record.exitPromise = this.#watchRecovered(record, entry);
    record.exitPromise.then((exit) => {
      this.#enqueue(() => this.#handleDefinitiveExit(record, exit));
    });
  }

  #inspectRecovery(entry) {
    if (typeof this.#launcher.inspectRecovery !== "function") {
      return { state: "ambiguous", detail: "this launcher cannot verify leftover runtimes" };
    }
    try {
      return this.#launcher.inspectRecovery(entry.ownership);
    } catch (error) {
      return { state: "ambiguous", detail: messageFor(error) };
    }
  }

  // A present runtime whose controller is gone, or an inspection that cannot
  // rule the generation in or out, has nobody left to clean it up. That is
  // reported as failed and keeps the slot; only the generation actually
  // disappearing resolves it.
  #recoveryProblem(inspection, deadline) {
    if (inspection.state === "ambiguous") {
      return `ownership could not be verified: ${inspection.detail}`;
    }
    if (!inspection.controllerLive) {
      return "its controller is gone, so it cannot be stopped safely from here";
    }
    if (Date.now() > deadline) {
      return "it did not exit after its controller was told Nexus was gone";
    }
    return null;
  }

  async #watchRecovered(record, entry) {
    const deadline = Date.now() + this.#recoveryDeadlineMs;
    let reported = null;
    while (!record.released) {
      const inspection = this.#inspectRecovery(entry);
      if (inspection.state === "absent") {
        return Object.freeze({ code: null, signal: null, error: null });
      }
      const problem = this.#recoveryProblem(inspection, deadline);
      if (problem !== null && problem !== reported) {
        reported = problem;
        this.#setState(entry.gameId, GAME_LIFECYCLE_STATUS.FAILED, {
          error: `runtime left by a previous Nexus run could not be confirmed stopped: ${problem}`,
        });
        this.#logger?.warn?.(
          `Runtime for ${entry.gameId} from a previous Nexus run is still present and ${problem}. `
          + "Nexus will not start another game. Stop that game's processes on this host; "
          + "this status clears by itself once they are gone.",
        );
      }
      await sleep(this.#recoveryPollMs, { background: true });
    }
    return Object.freeze({ code: null, signal: null, error: null });
  }

  // Stop for a recovered runtime never signals: it re-verifies and waits for the
  // controller's own cleanup, and fails closed if that cannot be shown.
  async #awaitRecoveredExit(record, entry) {
    const deadline = Date.now() + this.#recoveryDeadlineMs;
    while (true) {
      const inspection = this.#inspectRecovery(entry);
      if (inspection.state === "absent") {
        return Object.freeze({ forced: false, recovered: true });
      }
      const problem = this.#recoveryProblem(inspection, deadline);
      if (problem !== null) {
        throw recoveryError(
          "RECOVERY_UNRESOLVED",
          `runtime left by a previous Nexus run is still present and ${problem}`,
        );
      }
      await sleep(this.#recoveryPollMs);
    }
  }

  #scheduleBlockedRecheck() {
    setTimeout(() => {
      if (this.#blocked !== null) {
        this.#enqueue(() => this.#recover());
      }
    }, Math.max(this.#recoveryPollMs, 1_000)).unref();
  }

  #releaseProxyReference(record) {
    record.proxyReferences -= 1;
    if (record.proxyReferences === 0) {
      record.resolveProxyReferences?.();
      record.resolveProxyReferences = null;
    }
  }

  async #waitForProxyReferences(record) {
    if (record.proxyReferences === 0) {
      return;
    }
    await new Promise((resolve) => {
      record.resolveProxyReferences = resolve;
    });
  }

  async #handleDefinitiveExit(record, exit) {
    if (this.#active !== record) {
      return;
    }

    const priorState = this.#states.get(record.gameId);
    await this.#waitForProxyReferences(record);
    this.#releaseRecord(record);
    if (record.recovered === true) {
      // A leftover runtime ending is the expected outcome, not a failure.
      this.#logger?.info?.(`The runtime for ${record.gameId} from a previous Nexus run has exited.`);
      this.#setState(record.gameId, GAME_LIFECYCLE_STATUS.STOPPED);
      return;
    }
    if (priorState?.status === GAME_LIFECYCLE_STATUS.FAILED) {
      this.#setState(record.gameId, GAME_LIFECYCLE_STATUS.FAILED, {
        error: priorState.error,
      });
      return;
    }

    const detail = exit.error
      ? messageFor(exit.error)
      : `code ${exit.code ?? "null"}, signal ${exit.signal ?? "none"}`;
    this.#setState(record.gameId, GAME_LIFECYCLE_STATUS.FAILED, {
      error: `game runtime exited unexpectedly (${detail})`,
    });
  }
}
