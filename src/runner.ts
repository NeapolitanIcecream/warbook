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
import { SupalosaOpponent, SUPALOSA_VERSION } from "./opponent.js";
import { policyPlayerName } from "./player-identity.js";
import { recordDestruction } from "./referee.js";
import { createOfficialOpponent } from "./official-opponent.js";
import { loadBotRelease, type DrivenBot } from "./bot-release.js";
import { DecisionShadow, ShadowMismatch } from "./analysis/shadow.js";
import {
  ExperimentalLaunchProvider,
  LAUNCH_SCHEMA,
  LinearLaunchPolicy,
  type LaunchPolicy,
  type LinearLaunchModel,
} from "./learning/launch.js";
import {
  NeuralLaunchPolicy,
  prepareInference,
  type LaunchModel,
} from "./learning/model.js";
import { BastionStrategy } from "./control/bastion-strategy.js";
import { PressureStrategy } from "./control/pressure-strategy.js";

const { values } = parseArgs({
  options: {
    map: { type: "string", default: "mp03t4.map" },
    ticks: { type: "string", default: "54000" },
    seconds: { type: "string", default: "180" },
    units: { type: "string", default: "10" },
    mode: { type: "string", default: "bastion" },
    opponent: { type: "string", default: "supalosa" },
    "actor-release": { type: "string" },
    "opponent-release": { type: "string" },
    "shadow-release": { type: "string" },
    swap: { type: "boolean", default: false },
    out: { type: "string" },
    "launch-policy": { type: "string" },
    "launch-model": { type: "string" },
    "policy-seed": { type: "string", default: "0" },
    "launch-deterministic": { type: "boolean", default: false },
    "trace-level": { type: "string", default: "full" },
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
const trace = (event: unknown) => {
  if (
    values["trace-level"] === "launch" &&
    (event as { kind: string }).kind !== "launch_decision" &&
    !(
      (event as { kind: string; tick: number }).kind === "observation" &&
      (event as { tick: number }).tick % 450 === 0
    )
  )
    return;
  appendFileSync(`${dir}/decisions.ndjson`, JSON.stringify(event) + "\n");
};
let game: GameInstanceApi | undefined;
async function main(): Promise<void> {
  if (
    values["launch-policy"] &&
    (values["actor-release"] ||
      values["shadow-release"] ||
      !["bastion", "pressure"].includes(values.mode!))
  )
    throw new Error(
      "Experimental launch control needs a live layered subject, separate from frozen/shadow actors",
    );
  if (
    values["launch-policy"] &&
    !["teacher", "random", "model", "linear"].includes(values["launch-policy"])
  )
    throw new Error("Unknown launch policy");
  if (!["full", "launch"].includes(values["trace-level"]!))
    throw new Error("Unknown trace level");
  let neural: LaunchPolicy | undefined;
  if (values["launch-policy"] === "model") {
    if (!values["launch-model"]) throw new Error("Model artifact required");
    await prepareInference();
    neural = new NeuralLaunchPolicy(
      JSON.parse(readFileSync(values["launch-model"], "utf8")) as LaunchModel,
    );
  }
  if (values["launch-policy"] === "linear") {
    if (!values["launch-model"])
      throw new Error("Linear model artifact required");
    neural = new LinearLaunchPolicy(
      JSON.parse(
        readFileSync(values["launch-model"], "utf8"),
      ) as LinearLaunchModel,
    );
  }
  const launch = values["launch-policy"]
    ? new ExperimentalLaunchProvider(
        values["launch-policy"],
        values["policy-seed"]!,
        neural,
        values["launch-deterministic"],
      )
    : undefined;
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
  const subject = values["actor-release"]
    ? await loadBotRelease(values["actor-release"], (r) =>
        policyPlayerName(r.policyVersion, r.mode, "A"),
      )
    : {
        bot: new WarbookBot(
          policyPlayerName(
            POLICY_VERSION,
            launch
              ? `${values.mode}-launch-${values["launch-policy"]}`
              : values.mode!,
            "A",
          ),
          "Americans",
          values.mode as PolicyMode,
          launch
            ? {
                strategy:
                  values.mode === "pressure"
                    ? new PressureStrategy(launch)
                    : new BastionStrategy("bastion", launch),
              }
            : undefined,
        ),
        release: undefined,
      };
  const frozenOpponent = values["opponent-release"]
    ? await loadBotRelease(values["opponent-release"], (r) =>
        policyPlayerName(r.policyVersion, r.mode, "B"),
      )
    : undefined;
  const shadow = values["shadow-release"]
    ? await loadBotRelease(values["shadow-release"], "DecisionShadow")
    : undefined;
  if (
    shadow &&
    (shadow.release.mode !== subject.bot.mode ||
      shadow.release.observationProtocol !==
        (subject.release?.observationProtocol ?? OBSERVATION_PROTOCOL))
  )
    throw new Error(
      "A behavior shadow must share the subject mode and observation protocol",
    );
  const comparison = shadow ? new DecisionShadow() : undefined;
  const opponent =
    frozenOpponent?.bot ??
    (values.opponent === "official"
      ? createOfficialOpponent("Supalosa official 0.84.0 B")
      : values.opponent === "supalosa"
        ? new SupalosaOpponent(`Supalosa ${SUPALOSA_VERSION} B`)
        : new WarbookBot(
            policyPlayerName(POLICY_VERSION, values.opponent!, "B"),
            "Americans",
            values.opponent as PolicyMode,
          ));
  const opponentIsDriven =
    Boolean(frozenOpponent) || allowedModes.includes(values.opponent!);
  const agents = values.swap
    ? [opponent, subject.bot]
    : [subject.bot, opponent];
  const driven = new Set<DrivenBot>([subject.bot]);
  if (opponentIsDriven) driven.add(opponent as DrivenBot);
  const warbookAgents = agents.filter((bot): bot is DrivenBot =>
    driven.has(bot as DrivenBot),
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
    policy: subject.release?.policyVersion ?? POLICY_VERSION,
    modes: agents.map((a) => a.mode),
    participants: agents.map((bot) => ({
      name: bot.name,
      role: bot === subject.bot ? "subject" : "opponent",
      controller: driven.has(bot as DrivenBot)
        ? "synchronous-warbook"
        : "native-opponent",
      release: bot === subject.bot ? subject.release : frozenOpponent?.release,
    })),
    swapped: values.swap,
    ...(shadow
      ? {
          shadow: {
            release: shadow.release,
            scope:
              "decision-only; no engine initialization, observation or submission by the shadow",
          },
        }
      : {}),
    observationProtocol: OBSERVATION_PROTOCOL,
    ...(launch
      ? {
          launchExperiment: {
            schema: LAUNCH_SCHEMA,
            policy: values["launch-policy"],
            seed: values["policy-seed"],
            deterministic: values["launch-deterministic"],
            modelSha256: values["launch-model"]
              ? sha256(values["launch-model"])
              : undefined,
          },
        }
      : {}),
    decisionInterval: 3,
    batchOrder: agents.map((a) => a.name),
    lockHash: sha256("package-lock.json"),
    sourceHashes: Object.fromEntries(
      [
        "src/policy.ts",
        "src/legacy-policy.ts",
        "src/control/contracts.ts",
        "src/control/strategy.ts",
        "src/control/tactics.ts",
        "src/control/production.ts",
        "src/control/bastion-strategy.ts",
        "src/control/position-tactics.ts",
        "src/control/coordinator.ts",
        "src/analysis/shadow.ts",
        "src/raiding.ts",
        "src/regrouping.ts",
        "src/bridge.ts",
        "src/runner.ts",
        "src/opponent.ts",
        "src/official-opponent.ts",
        "src/model.ts",
        "src/effects.ts",
        "src/referee.ts",
        "src/engine-diagnostics.mjs",
        "src/bot-release.ts",
        "src/player-identity.ts",
        "src/control/launch-provider.ts",
        "src/learning/launch.ts",
        "src/learning/model.ts",
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
  recordDestruction(subject.bot, game.gameApi, (record) =>
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
        const intents = active.map((a, i) =>
          a === subject.bot && comparison && shadow
            ? comparison.decide(
                observations[i],
                (o) => a.decide(o),
                (o) => shadow.bot.decide(o),
              )
            : a.decide(observations[i]),
        );
        active.forEach((a, i) => a.submit(intents[i]));
        decisions += active.length;
        decisionMillis += performance.now() - t;
      }
      for (const bot of agents)
        if (
          !driven.has(bot as DrivenBot) &&
          !game.gameApi.isPlayerDefeated(bot.name)
        )
          (bot as ReturnType<typeof createOfficialOpponent>).step(game.gameApi);
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
    stopReason =
      e instanceof ShadowMismatch ? "shadow_mismatch" : "api_or_bot_exception";
    if (e instanceof ShadowMismatch)
      writeFileSync(
        `${dir}/shadow-mismatch.json`,
        JSON.stringify(
          {
            tick: e.observation.tick,
            observation: e.observation,
            live: e.live,
            shadow: e.shadow,
          },
          null,
          2,
        ),
      );
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
    ...(comparison ? { shadow: comparison.summary() } : {}),
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
