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

export class RuntimeSupervisor {
  #allocator;
  #launcher;
  #requireDistinctSecurityBoundary;
  #launchTokenFactory;
  #startupTimeoutMs;
  #pollIntervalMs;
  #requestTimeoutMs;
  #stopGracePeriodMs;
  #active = null;
  #states = new Map();
  #queue = Promise.resolve();

  constructor({
    allocator = new PrivatePortAllocator(),
    launcher = createLocalGameProcessLauncher(),
    requireDistinctSecurityBoundary = false,
    launchTokenFactory = defaultLaunchTokenFactory,
    startupTimeoutMs = 30_000,
    pollIntervalMs = 200,
    requestTimeoutMs = 1_000,
    stopGracePeriodMs = 5_000,
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
    for (const [name, value, allowZero] of [
      ["startupTimeoutMs", startupTimeoutMs, false],
      ["pollIntervalMs", pollIntervalMs, false],
      ["requestTimeoutMs", requestTimeoutMs, false],
      ["stopGracePeriodMs", stopGracePeriodMs, true],
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
    const { gameId, lease, basePath, status } = this.#active;
    return snapshot({
      gameId,
      host: lease.host,
      port: lease.port,
      basePath,
      status,
    });
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

  stop() {
    return this.#enqueue(() => this.#stopActive());
  }

  #enqueue(operation) {
    const run = this.#queue.then(operation, operation);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #setState(gameId, status, extra = {}) {
    const next = { gameId, status, ...extra };
    this.#states.set(gameId, next);
    if (this.#active?.gameId === gameId) {
      this.#active.status = status;
    }
    return snapshot(next);
  }

  async #start(game) {
    if (this.#active !== null) {
      await this.#stopActive();
    }

    const gameId = game.manifest.id;
    const basePath = `/games/${gameId}`;
    this.#setState(gameId, GAME_LIFECYCLE_STATUS.STARTING);

    let lease;
    let record;
    try {
      lease = await this.#allocator.allocate();
      const launchToken = createLaunchToken(this.#launchTokenFactory);
      const execution = launchSupervisedGameProcess(game, {
        launcher: this.#launcher,
        requireDistinctSecurityBoundary: this.#requireDistinctSecurityBoundary,
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
      } else if (lease !== undefined) {
        lease.release();
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
      record.lease.release();
    }
    if (this.#active === record) {
      this.#active = null;
    }
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
