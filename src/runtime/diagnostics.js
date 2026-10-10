import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { defaultStateDirectory } from "./ownership-journal.js";

export const DIAGNOSTICS_FILE = "runtime-diagnostics.json";
const STREAM_BYTES = 32 * 1024;
const LAUNCH_LIMIT = 4;
const DETAIL_CHARS = 4096;

// Host-only, best-effort storage. Atomic replacement never follows a target
// symlink, and a unique exclusive temporary file cannot overwrite another file.
export class FileDiagnosticWriter {
  constructor({ directory = defaultStateDirectory() } = {}) {
    this.directory = directory;
    this.path = join(directory, DIAGNOSTICS_FILE);
  }

  async write(value) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("diagnostic directory is not a real directory");
    }
    if (typeof process.getuid === "function"
      && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) {
      throw new Error("diagnostic directory must be owned by and private to the Nexus user");
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let file;
    let created = false;
    try {
      file = await open(temporary, "wx", 0o600);
      created = true;
      await file.writeFile(JSON.stringify(value, null, 2));
      await file.close();
      file = null;
      await rename(temporary, this.path);
    } finally {
      await file?.close();
      if (created) await rm(temporary, { force: true });
    }
  }
}

/** Bounded recent launch history; never used as lifecycle or recovery authority. */
export class RuntimeDiagnostics {
  #launches = [];
  #writer;
  #logger;
  #timer = null;
  #writing = null;
  #dirty = false;

  constructor({ writer = null, logger = console } = {}) {
    this.#writer = writer;
    this.#logger = logger;
  }

  begin(gameId) {
    const secrets = [];
    const streams = Object.fromEntries(["stdout", "stderr"].map((name) => [name, {
      decoder: new StringDecoder("utf8"), pending: "", tail: Buffer.alloc(0),
      droppedBytes: 0, ended: false,
    }]));
    const data = {
      launchId: randomUUID(), gameId, startedAt: new Date().toISOString(),
      status: "starting", outputAvailable: false,
    };
    const launch = { data, streams, retired: false };
    this.#launches.push(launch);
    if (this.#launches.length > LAUNCH_LIMIT) {
      const retired = this.#launches.shift();
      retired.retired = true;
      for (const stream of Object.values(retired.streams)) {
        stream.tail = Buffer.alloc(0);
        stream.pending = "";
      }
      retired.streams = {};
    }
    const redact = (text) => {
      for (const secret of secrets) text = text.split(secret).join("[redacted]");
      return text;
    };
    const append = (stream, text, final = false) => {
      let input = redact(stream.pending + text);
      stream.pending = "";
      // Hold any unfinished token prefix across chunks AND file snapshots.
      // On EOF discard it: even a game printing only a token prefix stays private.
      let held = 0;
      for (const secret of secrets) {
        for (let size = Math.min(secret.length - 1, input.length); size > held; size -= 1) {
          if (input.endsWith(secret.slice(0, size))) { held = size; break; }
        }
      }
      if (held > 0) {
        stream.pending = final ? "" : input.slice(-held);
        input = input.slice(0, -held);
      }
      const bytes = Buffer.from(input);
      const combined = Buffer.concat([stream.tail, bytes]);
      const dropped = Math.max(0, combined.length - STREAM_BYTES);
      stream.droppedBytes += dropped;
      // Copy the tail so a tiny retained slice never pins a large input buffer.
      stream.tail = Buffer.from(combined.subarray(dropped));
      this.#changed();
    };
    const sink = {
      gameId,
      addSecrets(values) {
        for (const value of values) {
          if (typeof value === "string" && value !== "" && !secrets.includes(value)) secrets.push(value);
        }
      },
      available: () => { data.outputAvailable = true; this.#changed(); },
      write: (name, chunk) => {
        if (launch.retired || !streams[name] || streams[name].ended) return;
        append(streams[name], streams[name].decoder.write(Buffer.from(chunk)));
      },
      end: (name) => {
        if (launch.retired || !streams[name] || streams[name].ended) return;
        append(streams[name], streams[name].decoder.end(), true);
        streams[name].ended = true;
      },
      error: (name, error) => {
        data.outputError = redact(`${name}: ${error.message ?? error}`).slice(0, DETAIL_CHARS);
        this.#changed();
      },
      update: (state) => {
        if (launch.retired) return;
        data.status = state.status;
        if (state.failureReason) data.failureReason = state.failureReason;
        if (state.error) data.detail = redact(String(state.error)).slice(0, DETAIL_CHARS);
        this.#changed();
      },
      exit: (exit) => {
        if (launch.retired) return;
        data.endedAt = new Date().toISOString();
        data.exit = {
          code: exit.code ?? null, signal: exit.signal ?? null,
          ...(exit.error ? { error: redact(String(exit.error.message ?? exit.error)).slice(0, DETAIL_CHARS) } : {}),
        };
        this.#changed();
      },
    };
    this.#changed();
    return Object.freeze(sink);
  }

  snapshot() {
    return {
      version: 1,
      limits: { launches: LAUNCH_LIMIT, bytesPerStream: STREAM_BYTES },
      launches: this.#launches.map(({ data, streams }) => ({
        ...structuredClone(data),
        ...Object.fromEntries(Object.entries(streams).map(([name, stream]) => [name, {
          text: stream.tail.toString("utf8"), droppedBytes: stream.droppedBytes,
        }])),
      })),
    };
  }

  #changed() {
    this.#dirty = true;
    if (this.#writer === null || this.#timer !== null || this.#writing !== null) return;
    // Coalesce output bursts. Disk I/O never sits on the game's drain path.
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, 250);
    this.#timer.unref();
  }

  async flush() {
    while (this.#writing !== null) await this.#writing;
    clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#writer === null || !this.#dirty) return;
    // Only one in-flight snapshot; subsequent changes replace the pending one.
    // Flush one snapshot, rather than chasing a still-running noisy game forever
    // (in particular when shutdown could not confirm that game's termination).
    this.#dirty = false;
    const value = this.snapshot();
    this.#writing = (async () => {
      try {
        await this.#writer.write(value);
      } catch (error) {
        this.#writer = null;
        this.#logger?.warn?.(`Runtime diagnostic file unavailable; collection continues in memory (${error.code ?? "write failed"}).`);
      }
    })();
    try { await this.#writing; } finally {
      this.#writing = null;
      if (this.#dirty) this.#changed();
    }
  }
}

/** Install readers before launching the Linux root or waiting for readiness. */
export function drainRuntimeOutput(child, output, secrets) {
  const call = (method, ...args) => {
    // Diagnostics are optional and must never affect process ownership or cleanup.
    try { output[method]?.(...args); } catch { /* keep draining */ }
  };
  call("addSecrets", secrets);
  if (child.stdout && child.stderr) call("available");
  for (const name of ["stdout", "stderr"]) {
    const stream = child[name];
    if (!stream) continue;
    stream.on("data", (chunk) => call("write", name, chunk));
    stream.on("error", (error) => call("error", name, error));
    stream.once("end", () => call("end", name));
    stream.once("close", () => call("end", name));
  }
}
