import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export const CURRENT_GAME_SCHEMA = 2;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertRecord(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function parseManifest(value) {
  assertRecord(value, "manifest");

  if (value.schema !== CURRENT_GAME_SCHEMA) {
    throw new Error(`manifest.schema must be ${CURRENT_GAME_SCHEMA}`);
  }
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    throw new Error("manifest.id must be a lowercase kebab-case identifier");
  }
  assertNonEmptyString(value.name, "manifest.name");
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error("manifest.description must be a string when present");
  }

  assertRecord(value.players, "manifest.players");
  assertPositiveInteger(value.players.min, "manifest.players.min");
  assertPositiveInteger(value.players.max, "manifest.players.max");
  if (value.players.max < value.players.min) {
    throw new Error("manifest.players.max must be >= manifest.players.min");
  }

  assertRecord(value.capabilities, "manifest.capabilities");
  if (value.capabilities.tvLess !== true) {
    throw new Error("manifest.capabilities.tvLess must be true");
  }
  for (const key of ["personalDevices", "dedicatedDisplay"]) {
    if (value.capabilities[key] !== undefined && typeof value.capabilities[key] !== "boolean") {
      throw new Error(`manifest.capabilities.${key} must be boolean when present`);
    }
  }

  assertRecord(value.runtime, "manifest.runtime");
  assertNonEmptyString(value.runtime.command, "manifest.runtime.command");
  if (!Array.isArray(value.runtime.args) || value.runtime.args.some((arg) => typeof arg !== "string")) {
    throw new Error("manifest.runtime.args must be an array of strings");
  }

  return value;
}

function parseConfig(value) {
  assertRecord(value, "config");
  if (!Array.isArray(value.games)) {
    throw new Error("config.games must be an array");
  }

  return {
    games: value.games.map((entry, index) => {
      assertRecord(entry, `config.games[${index}]`);
      assertNonEmptyString(entry.path, `config.games[${index}].path`);
      return { path: entry.path };
    }),
  };
}

async function readJson(path, label) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw Object.assign(new Error(`${label} not found: ${path}`), { code: "ENOENT" });
    }
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} contains invalid JSON: ${path}`, { cause: error });
  }
}

export async function loadLibrary(configPath) {
  let configValue;
  try {
    configValue = await readJson(configPath, "config");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const config = parseConfig(configValue);
  const configDir = dirname(resolve(configPath));
  const installed = [];
  const ids = new Set();

  for (const entry of config.games) {
    const root = isAbsolute(entry.path) ? resolve(entry.path) : resolve(configDir, entry.path);
    const manifestPath = resolve(root, "boardgame.json");
    const manifest = parseManifest(await readJson(manifestPath, "manifest"));

    if (ids.has(manifest.id)) {
      throw new Error(`duplicate game id: ${manifest.id}`);
    }
    ids.add(manifest.id);
    installed.push({ root, manifest });
  }

  return installed;
}

export function toPublicGame(game) {
  const { id, name, description, players, capabilities } = game.manifest;
  return {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    players: { min: players.min, max: players.max },
    capabilities: {
      tvLess: true,
      ...(capabilities.personalDevices === undefined ? {} : { personalDevices: capabilities.personalDevices }),
      ...(capabilities.dedicatedDisplay === undefined ? {} : { dedicatedDisplay: capabilities.dedicatedDisplay }),
    },
    status: "configured",
  };
}
