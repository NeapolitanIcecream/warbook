import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const repo = resolve(".");

async function browserProduction(native: boolean) {
  // The game/client and neural inference are architectural boundaries. The
  // installed BotFactory hook and its real ProgramProduction executor run here.
  const output = await build({
    entryPoints: ["src/player/integration.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    define: {
      __WARBOOK_POLICY__: '"bastion"',
      __WARBOOK_LAUNCH_MODEL__: JSON.stringify({
        format: "warbook-commander-model-v1",
        schema: "commander-v1",
      }),
      __WARBOOK_TACTICAL_MODEL__: "null",
      __WARBOOK_COMMANDER_NATIVE_BATCHES__: String(native),
    },
    plugins: [
      {
        name: "player-boundaries",
        setup(b) {
          b.onResolve({ filter: /bridge\.js$/ }, () => ({
            path: "bridge",
            namespace: "fixture",
          }));
          b.onResolve({ filter: /commander\/network\.js$/ }, () => ({
            path: "commander-network",
            namespace: "fixture",
          }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, (a) => ({
            loader: "js",
            contents:
              a.path === "bridge"
                ? "export const OBSERVATION_PROTOCOL='api-shroud-v1-pregame-map-prior'; export class WarbookBot { constructor(name,country,mode,components){this.name=name;this.components=components;} }"
                : "export async function prepareCommander(){}; export class NeuralCommanderPolicy { hiddenSize=128; encoding='graph-plan-v2'; }",
          }));
        },
      },
    ],
  });
  class BotFactory {
    create(_player: unknown): any {}
  }
  class SkirmishScreen {
    async initOptions() {}
  }
  class GameScreen {
    async onLeave() {}
  }
  const modules: Record<string, unknown> = {
    "game/bot/BotFactory": { BotFactory },
    "game/GameFactory": { GameFactory: { create() {} } },
    "gui/screen/mainMenu/lobby/SkirmishScreen": { SkirmishScreen },
    LocalPrefs: { StorageKey: {} },
    "gui/screen/game/GameScreen": { GameScreen },
    "engine/Engine": { Engine: {} },
  };
  const module: any = { exports: {} };
  runInNewContext(output.outputFiles[0].text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    location: { hash: "" },
    crypto: { randomUUID: () => "contract-session" },
    SystemJS: { import: async (name: string) => modules[name] },
    localStorage: { getItem: () => "1" },
    document: { createElement: () => ({ style: {} }), body: { append() {} } },
    window: { addEventListener() {} },
    setInterval() {},
  });
  await module.exports.install();
  await new SkirmishScreen().initOptions();
  return new BotFactory().create({
    name: "contract-player",
    country: { name: "Americans" },
  }).components.production;
}

test("browser commander factory emits finite native batches only when explicitly enabled", async () => {
  const product = { name: "E1", queue: 2, type: 3, cost: 200 };
  const observation = {
    tick: 0,
    side: 0,
    credits: 10000,
    power: { total: 200, drain: 0, isLowPower: false },
    home: { x: 20, y: 20 },
    starts: [],
    own: [],
    enemies: [],
    products: [product],
    catalogue: [product],
    buildSites: [],
    queues: Array.from({ length: 6 }, (_, type) => ({
      type,
      status: 0,
      size: 0,
      maxSize: 30,
      items: [],
    })),
  };
  const plan = {
    id: "production",
    revision: 1,
    deploymentUnits: [],
    program: {
      queues: [{ queue: 2, mode: "run", product: "E1", target: 4, reserve: 0 }],
      placements: [],
      repair: [],
      sell: [],
    },
  };
  const native = await browserProduction(true);
  assert.equal(native.executionMode, "native-finite-batches-v1");
  assert.equal(native.control(observation, plan, []).intents[0].quantity, 4);
  const legacy = await browserProduction(false);
  assert.equal(legacy.executionMode, "single-item-v1");
  assert.equal(
    legacy.control(observation, plan, []).intents[0].quantity ?? 1,
    1,
  );
});

function withPlayerBuild(
  run: (directory: string, env: NodeJS.ProcessEnv) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "warbook-player-contract-"));
  symlinkSync(join(repo, "src"), join(directory, "src"), "dir");
  symlinkSync(
    join(repo, "node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_DIR: execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
    }).trim(),
    GIT_WORK_TREE: repo,
  };
  for (const key of [
    "PLAYER_COMMANDER_MODEL",
    "PLAYER_LAUNCH_MODEL",
    "PLAYER_TACTICAL_MODEL",
    "PLAYER_COMMANDER_NATIVE_BATCHES",
  ])
    delete env[key];
  try {
    run(directory, env);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function playerBuild(directory: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", join(repo, "scripts/build-player.ts")],
    {
      cwd: directory,
      env,
      encoding: "utf8",
      timeout: 30000,
    },
  );
}

test("frozen player metadata declares the commander production mode actually built", () => {
  withPlayerBuild((directory, env) => {
    const model = join(directory, "model.json");
    // Packaging reads the model as data; inference validity is tested elsewhere.
    writeFileSync(
      model,
      JSON.stringify({
        format: "warbook-commander-model-v1",
        schema: "commander-v1",
      }),
    );
    for (const [flag, mode] of [
      [undefined, "single-item-v1"],
      ["1", "native-finite-batches-v1"],
      ["0", "single-item-v1"],
    ]) {
      const result = playerBuild(directory, {
        ...env,
        PLAYER_COMMANDER_MODEL: model,
        PLAYER_COMMANDER_NATIVE_BATCHES: flag,
      });
      assert.equal(result.status, 0, result.stderr);
      const release = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
      assert.equal(release.commanderExecutionMode, mode);
      assert.equal(
        JSON.parse(
          readFileSync(
            join(directory, "dist/player", release.sha256, "release.json"),
            "utf8",
          ),
        ).commanderExecutionMode,
        mode,
      );
    }
  });
});

test("player build rejects native commander batches without a commander model", () => {
  withPlayerBuild((directory, env) => {
    const result = playerBuild(directory, {
      ...env,
      PLAYER_COMMANDER_NATIVE_BATCHES: "1",
    });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Native finite batches require a commander model/,
    );
  });
});
