import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLibrary, parseManifest, toPublicGame } from "../src/registry.js";

const validManifest = {
  schema: 1,
  id: "fixture-game",
  name: "Fixture Game",
  description: "Original test fixture.",
  players: { min: 2, max: 4 },
  capabilities: { tvLess: true, personalDevices: true },
  runtime: {
    command: "node",
    args: ["server.js"],
    healthPath: "/healthz",
  },
} as const;

describe("game manifest", () => {
  it("accepts the schema-1 baseline", () => {
    expect(parseManifest(validManifest).id).toBe("fixture-game");
  });

  it("rejects games without TV-less support", () => {
    expect(() =>
      parseManifest({
        ...validManifest,
        capabilities: { ...validManifest.capabilities, tvLess: false },
      }),
    ).toThrow(/tvLess/);
  });
});

describe("library discovery", () => {
  it("treats a missing local config as an empty library", async () => {
    const root = await mkdtemp(join(tmpdir(), "tabletop-nexus-"));
    await expect(loadLibrary(join(root, "missing.json"))).resolves.toEqual([]);
  });

  it("loads manifests relative to the local config and hides runtime details from public metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "tabletop-nexus-"));
    const gameRoot = join(root, "game");
    await mkdir(gameRoot);
    await writeFile(join(gameRoot, "boardgame.json"), JSON.stringify(validManifest));
    await writeFile(join(root, "nexus.config.json"), JSON.stringify({ games: [{ path: "./game" }] }));

    const [game] = await loadLibrary(join(root, "nexus.config.json"));
    expect(game?.root).toBe(gameRoot);

    const publicGame = toPublicGame(game!);
    expect(publicGame).toMatchObject({ id: "fixture-game", status: "configured" });
    expect(publicGame).not.toHaveProperty("root");
    expect(publicGame).not.toHaveProperty("runtime");
  });
});
