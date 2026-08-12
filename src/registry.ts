import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { GameManifest, InstalledGame, NexusConfig, PublicGame } from "./types.js";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
}

function assertInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function parseManifest(value: unknown): GameManifest {
  assertRecord(value, "manifest");

  if (value.schema !== 1) throw new Error("manifest.schema must be 1");
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    throw new Error("manifest.id must be a lowercase kebab-case identifier");
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new Error("manifest.name must be a non-empty string");
  }
  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error("manifest.description must be a string when present");
  }

  assertRecord(value.players, "manifest.players");
  assertInteger(value.players.min, "manifest.players.min");
  assertInteger(value.players.max, "manifest.players.max");
  if (value.players.max < value.players.min) {
    throw new Error("manifest.players.max must be >= manifest.players.min");
  }

  assertRecord(value.capabilities, "manifest.capabilities");
  if (value.capabilities.tvLess !== true) {
    throw new Error("manifest.capabilities.tvLess must be true");
  }
  for (const key of ["personalDevices", "dedicatedDisplay"] as const) {
    const item = value.capabilities[key];
    if (item !== undefined && typeof item !== "boolean") {
      throw new Error(`manifest.capabilities.${key} must be boolean when present`);
    }
  }

  assertRecord(value.runtime, "manifest.runtime");
  if (typeof value.runtime.command !== "string" || value.runtime.command.trim() === "") {
    throw new Error("manifest.runtime.command must be a non-empty string");
  }
  if (!Array.isArray(value.runtime.args) || value.runtime.args.some((arg) => typeof arg !== "string")) {
    throw new Error("manifest.runtime.args must be an array of strings");
  }
  if (
    typeof value.runtime.healthPath !== "string" ||
    !value.runtime.healthPath.startsWith("/") ||
    value.runtime.healthPath.includes("?")
  ) {
    throw new Error("manifest.runtime.healthPath must be an absolute path without a query string");
  }

  return value as unknown as GameManifest;
}

function parseConfig(value: unknown): NexusConfig {
  assertRecord(value, "config");
  if (!Array.isArray(value.games)) throw new Error("config.games must be an array");
  const games = value.games.map((entry, index) => {
    assertRecord(entry, `config.games[${index}]`);
    if (typeof entry.path !== "string" || entry.path.trim() === "") {
      throw new Error(`config.games[${index}].path must be a non-empty string`);
    }
    return { path: entry.path };
  });
  return { games };
}

export async function loadLibrary(configPath: string): Promise<InstalledGame[]> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }

  const config = parseConfig(JSON.parse(raw) as unknown);
  const configDir = dirname(resolve(configPath));
  const installed: InstalledGame[] = [];
  const ids = new Set<string>();

  for (const entry of config.games) {
    const root = isAbsolute(entry.path) ? resolve(entry.path) : resolve(configDir, entry.path);
    const manifestPath = resolve(root, "boardgame.json");
    const manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
    if (ids.has(manifest.id)) throw new Error(`duplicate game id: ${manifest.id}`);
    ids.add(manifest.id);
    installed.push({ root, manifest });
  }

  return installed;
}

export function toPublicGame(game: InstalledGame): PublicGame {
  const { id, name, description, players, capabilities } = game.manifest;
  return {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    players,
    capabilities,
    status: "configured",
  };
}
