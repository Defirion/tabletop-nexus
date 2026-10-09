import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const OWNERSHIP_JOURNAL_VERSION = 1;
export const OWNERSHIP_JOURNAL_FILE = "runtime-ownership.json";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Default location for restart-recovery state. A per-user directory under the
 * temporary root is deliberate: the record only describes processes that die
 * with a reboot or container recreation, so it needs no durable storage, and it
 * works with the read-only container root used by the LAN deployment profile.
 * `NEXUS_STATE_DIR` selects another writable directory.
 */
export function defaultStateDirectory(env = process.env) {
  if (typeof env.NEXUS_STATE_DIR === "string" && env.NEXUS_STATE_DIR !== "") {
    return env.NEXUS_STATE_DIR;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `tabletop-nexus-${uid}`);
}

function unreadable(reason) {
  return Object.freeze({ status: "unreadable", reason });
}

function validateEntry(entry) {
  return entry !== null
    && typeof entry === "object"
    && entry.version === OWNERSHIP_JOURNAL_VERSION
    && typeof entry.gameId === "string" && entry.gameId !== ""
    && Number.isInteger(entry.privatePort) && entry.privatePort > 0
    && typeof entry.phase === "string"
    && entry.ownership !== null && typeof entry.ownership === "object";
}

/**
 * Single-slot record of the runtime generation Nexus currently owns.
 *
 * Nexus runs at most one game, so there is at most one entry. The journal stores
 * ownership evidence only (the launcher's generation descriptor and the private
 * port); it never decides ownership. A reader must still verify the evidence
 * against the live system through the launcher before acting on it.
 *
 * Operations are synchronous on purpose: the launch path must have the record
 * on disk before the runtime is allowed to start.
 */
export class FileOwnershipJournal {
  #directory;
  #path;

  constructor({ directory = defaultStateDirectory() } = {}) {
    if (typeof directory !== "string" || directory === "") {
      throw new TypeError("directory must be a non-empty string");
    }
    this.#directory = directory;
    this.#path = join(directory, OWNERSHIP_JOURNAL_FILE);
  }

  get path() {
    return this.#path;
  }

  #ensureDirectory() {
    mkdirSync(this.#directory, { recursive: true, mode: DIRECTORY_MODE });
    const stat = lstatSync(this.#directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("state directory is not a real directory");
    }
    if (typeof process.getuid === "function") {
      if (stat.uid !== process.getuid()) {
        throw new Error("state directory is owned by another user");
      }
      if ((stat.mode & 0o077) !== 0) {
        throw new Error("state directory must not be accessible to other users");
      }
    }
  }

  write(entry) {
    const record = { ...entry, version: OWNERSHIP_JOURNAL_VERSION };
    if (!validateEntry(record)) {
      throw new TypeError("invalid ownership journal entry");
    }
    this.#ensureDirectory();
    // Write a private temporary file, flush it, then rename over the record, so
    // a crash leaves either the previous complete record or the new one.
    const temporary = `${this.#path}.${process.pid}.tmp`;
    const descriptor = openSync(temporary, "w", FILE_MODE);
    try {
      writeSync(descriptor, JSON.stringify(record));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, this.#path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  /** @returns {{status: "empty"} | {status: "entry", entry: object} | {status: "unreadable", reason: string}} */
  read() {
    let text;
    try {
      const stat = lstatSync(this.#path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return unreadable("ownership record is not a regular file");
      }
      text = readFileSync(this.#path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return Object.freeze({ status: "empty" });
      }
      return unreadable(`ownership record could not be read: ${error?.code ?? error?.message}`);
    }

    let entry;
    try {
      entry = JSON.parse(text);
    } catch {
      return unreadable("ownership record is not valid JSON");
    }
    if (!validateEntry(entry)) {
      return unreadable("ownership record has an unsupported shape or version");
    }
    return Object.freeze({ status: "entry", entry });
  }

  clear() {
    rmSync(this.#path, { force: true });
  }
}

/** In-memory journal with the same contract, for tests and embedders. */
export class MemoryOwnershipJournal {
  #value = null;
  #unreadableReason = null;

  write(entry) {
    const record = { ...entry, version: OWNERSHIP_JOURNAL_VERSION };
    if (!validateEntry(record)) {
      throw new TypeError("invalid ownership journal entry");
    }
    this.#unreadableReason = null;
    this.#value = structuredClone(record);
  }

  read() {
    if (this.#unreadableReason !== null) {
      return unreadable(this.#unreadableReason);
    }
    return this.#value === null
      ? Object.freeze({ status: "empty" })
      : Object.freeze({ status: "entry", entry: structuredClone(this.#value) });
  }

  clear() {
    this.#value = null;
    this.#unreadableReason = null;
  }

  /** Test seam: make the next read report a damaged record. */
  corrupt(reason = "ownership record is not valid JSON") {
    this.#unreadableReason = reason;
  }
}
