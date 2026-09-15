import {
  cdapi,
  Replay,
  type CreateOfflineOpts,
  type GameInstanceApi,
} from "@chronodivide/game-api";
import * as engine from "@chronodivide/game-api";
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { WarbookBot, OBSERVATION_PROTOCOL } from "./bridge.js";
import { POLICY_VERSION, POLICY_MODES, type PolicyMode } from "./policy.js";
import { SupalosaOpponent } from "./opponent.js";
import { recordDestruction } from "./referee.js";
import { createOfficialOpponent } from "./official-opponent.js";

const { values } = parseArgs({
  options: {
    map: { type: "string", default: "mp03t4.map" },
    ticks: { type: "string", default: "54000" },
    seconds: { type: "string", default: "180" },
    units: { type: "string", default: "10" },
    mode: { type: "string", default: "combined" },
    opponent: { type: "string", default: "supalosa" },
    out: { type: "string" },
  },
});
const start = performance.now();
const runId =
  new Date().toISOString().replace(/[:.]/g, "-") +
  "-" +
  randomUUID().slice(0, 8);
const dir = resolve(values.out ?? `runs/${runId}`);
mkdirSync(dir, { recursive: true });
const mixDir = resolve(process.env.MIX_DIR ?? "assets/ra2");
const sha256 = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const trace = (event: unknown) =>
  appendFileSync(`${dir}/decisions.ndjson`, JSON.stringify(event) + "\n");
let game: GameInstanceApi | undefined;
async function main(): Promise<void> {
  const allowedModes: readonly string[] = POLICY_MODES;
  if (
    !allowedModes.includes(values.mode!) ||
    ![...allowedModes, "supalosa", "official"].includes(values.opponent!)
  ) {
    throw new Error("Unknown policy mode");
  }
  for (const key of ["ticks", "seconds", "units"] as const) {
    if (!Number.isFinite(Number(values[key])) || Number(values[key]) < 0)
      throw new Error(`Invalid ${key}`);
  }
  const agents = [
    new WarbookBot("WarbookRed", "Americans", values.mode as PolicyMode),
    values.opponent === "official"
      ? createOfficialOpponent("OfficialBlue")
      : values.opponent === "supalosa"
        ? new SupalosaOpponent("SupalosaBlue")
        : new WarbookBot(
            "WarbookBlue",
            "Americans",
            values.opponent as PolicyMode,
          ),
  ];
  const warbookAgents = agents.filter(
    (bot): bot is WarbookBot => bot instanceof WarbookBot,
  );
  warbookAgents.forEach((bot) => (bot.trace = trace));
  const manifest = {
    runId,
    startedAt: new Date().toISOString(),
    git: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    dirty: !!execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim(),
    node: process.version,
    api: "0.79.0",
    referenceClientVersion: "0.83.3",
    bundledEngineSourceVersion: "0.83.3",
    policy: POLICY_VERSION,
    modes: agents.map((a) => a.mode),
    observationProtocol: OBSERVATION_PROTOCOL,
    decisionInterval: 3,
    batchOrder: agents.map((a) => a.name),
    lockHash: sha256("package-lock.json"),
    sourceHashes: Object.fromEntries(
      [
        "src/policy.ts",
        "src/bridge.ts",
        "src/runner.ts",
        "src/opponent.ts",
        "src/official-opponent.ts",
        "src/model.ts",
        "src/effects.ts",
        "src/referee.ts",
        "src/engine-diagnostics.mjs",
      ].map((path) => [path, sha256(path)]),
    ),
    resources: ["ra2.mix", "language.mix", "multi.mix"].map((name) => ({
      name,
      sha256: sha256(`${mixDir}/${name}`),
    })),
    randomness: "engine uncontrolled; starts recorded after initialization",
    limits: { ticks: Number(values.ticks), seconds: Number(values.seconds) },
  };
  writeFileSync(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));
  await cdapi.init(mixDir);
  const options: CreateOfflineOpts = {
    agents,
    mapName: values.map!,
    gameMode: cdapi.getAvailableGameModes(values.map!)[0],
    buildOffAlly: false,
    cratesAppear: false,
    credits: 10000,
    gameSpeed: 5,
    mcvRepacks: true,
    shortGame: true,
    superWeapons: false,
    unitCount: Number(values.units),
  };
  game = await cdapi.createGame(options);
  const runningGame = game;
  const rulesHash = createHash("sha256")
    .update(game.gameApi.getRulesIni().toString())
    .digest("hex");
  recordDestruction(agents[0], game.gameApi, (record) =>
    appendFileSync(`${dir}/referee.ndjson`, JSON.stringify(record) + "\n"),
  );
  const initial = game.getPlayerStats().map((p) => ({
    name: p.name,
    country: p.country.name,
    startLocation: p.startLocation,
    credits: p.credits,
  }));
  writeFileSync(
    `${dir}/initial.json`,
    JSON.stringify(
      {
        players: initial,
        rulesHash,
        allied: game.gameApi.areAlliedPlayers(agents[0].name, agents[1].name),
        options: { ...options, agents: initial.map((p) => p.name) },
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ event: "started", runId, dir, initial }));
  let error: string | undefined;
  let stopReason = "runner_limit";
  let decisions = 0,
    decisionMillis = 0;
  try {
    while (
      !game.isFinished() &&
      game.getCurrentTick() < manifest.limits.ticks &&
      (performance.now() - start) / 1000 < manifest.limits.seconds
    ) {
      if (game.getCurrentTick() % 3 === 0) {
        const t = performance.now();
        const active = warbookAgents.filter(
          (a) => !runningGame.gameApi.isPlayerDefeated(a.name),
        );
        const observations = active.map((a) => a.observe());
        const intents = active.map((a, i) => a.decide(observations[i]));
        active.forEach((a, i) => a.submit(intents[i]));
        decisions += active.length;
        decisionMillis += performance.now() - t;
      }
      for (const bot of agents)
        if (
          !(bot instanceof WarbookBot) &&
          !game.gameApi.isPlayerDefeated(bot.name)
        )
          bot.step(game.gameApi);
      await game.update();
      if (game.getCurrentTick() % 4500 === 0)
        console.log(
          JSON.stringify({
            event: "progress",
            tick: game.getCurrentTick(),
            seconds: (performance.now() - start) / 1000,
            players: warbookAgents.map((a) => ({
              name: a.name,
              credits: a.observation?.credits,
              own: a.observation?.own.length,
              types: a.observation?.own.reduce<Record<string, number>>(
                (r, u) => ((r[u.name] = (r[u.name] ?? 0) + 1), r),
                {},
              ),
            })),
          }),
        );
    }
    if (game.isFinished()) stopReason = "api_finished_unspecified";
  } catch (e) {
    error = e instanceof Error ? e.stack : String(e);
    stopReason = "api_or_bot_exception";
  }
  const stats = game.getPlayerStats().map((p) => ({
    name: p.name,
    country: p.country.name,
    defeated: p.defeated,
    credits: p.credits,
    startLocation: p.startLocation,
  }));
  const outcome =
    stats.filter((s) => s.defeated).length === 1
      ? {
          type: "one_defeat_observed",
          survivor: stats.find((s) => !s.defeated)!.name,
        }
      : { type: "outcome_unresolved" };
  const replay = game.saveReplay(dir);
  const replayMetadata = Replay.parse(readFileSync(replay, "utf8"));
  const stopState = (
    engine as unknown as {
      warbookReadStopState: (instance: unknown) => {
        status: string;
        turnManagerError: boolean;
      };
    }
  ).warbookReadStopState(game);
  const cleanCompletionVerified =
    stopState.status === "Ended" &&
    !stopState.turnManagerError &&
    !error &&
    outcome.type === "one_defeat_observed";
  if (cleanCompletionVerified) stopReason = "engine_ended";
  const result = {
    runId,
    stopReason,
    outcome,
    cleanCompletionVerified,
    stopState,
    tick: game.getCurrentTick(),
    wallSeconds: (performance.now() - start) / 1000,
    isFinished: game.isFinished(),
    stats,
    error,
    replay: {
      file: replay,
      sha256: sha256(replay),
      engineVersion: replayMetadata.engineVersion,
      modHash: replayMetadata.modHash,
      mapDigest: replayMetadata.gameOpts.mapDigest,
    },
    decisions,
    decisionMillis,
  };
  writeFileSync(`${dir}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ event: "result", ...result }));
  if (error) process.exitCode = 1;
}
try {
  await main();
} catch (error) {
  const result = {
    runId,
    stopReason: game ? "runner_recording_error" : "initialization_error",
    cleanCompletionVerified: false,
    wallSeconds: (performance.now() - start) / 1000,
    error: error instanceof Error ? error.stack : String(error),
  };
  writeFileSync(`${dir}/result.json`, JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  game?.dispose();
}
