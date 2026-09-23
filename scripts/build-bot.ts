import { build, version as esbuildVersion } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isBuiltin } from "node:module";
import { parseArgs } from "node:util";
import { engineHashes, fileHash, type BotRelease } from "../src/bot-release.js";

export async function buildBot(
  ref: string,
  mode = "combined",
  modelPath?: string,
) {
  const launchModel = modelPath
    ? JSON.parse(readFileSync(modelPath, "utf8"))
    : undefined;
  const commanderModel = launchModel?.format === "warbook-commander-model-v1";
  const contactModel = [
    "operation-contact-v1",
    "operation-maneuver-v1",
  ].includes(launchModel?.schema);
  const operationModel = launchModel?.schema === "operation-v2" || contactModel;
  if (contactModel && !["local", "zero"].includes(launchModel.contactInput))
    throw new Error("Contact artifact requires its observation mode");
  const maneuverModel = launchModel?.schema === "operation-maneuver-v1";
  if (!maneuverModel && launchModel?.maneuverScope !== undefined)
    throw new Error("Maneuver scope requires the maneuver schema");
  if (
    maneuverModel &&
    (!contactModel ||
      launchModel.controlScope !== "operation" ||
      !["base", "local"].includes(launchModel.maneuverScope))
  )
    throw new Error("Invalid local maneuver model");
  if (
    operationModel &&
    !["launch", "operation"].includes(launchModel.controlScope)
  )
    throw new Error("Operation artifact requires its training scope");
  const modelSha = modelPath ? fileHash(modelPath) : undefined;
  if (launchModel && !["bastion", "pressure"].includes(mode))
    throw new Error("Launch models require a supported layered mode");
  const git = execFileSync(
    "git",
    ["rev-parse", "--verify", `${ref}^{commit}`],
    { encoding: "utf8" },
  ).trim();
  mkdirSync("work", { recursive: true });
  const source = mkdtempSync(resolve("work/bot-source-"));
  try {
    const archive = execFileSync("git", ["archive", "--format=tar", git], {
      maxBuffer: 32 * 1024 * 1024,
    });
    execFileSync("tar", ["-xf", "-", "-C", source], { input: archive });
    const lockSha256 = fileHash(`${source}/package-lock.json`);
    const expectedApi = JSON.parse(
      readFileSync(`${source}/package.json`, "utf8"),
    ).dependencies["@chronodivide/game-api"];
    const installedApi = JSON.parse(
      readFileSync("node_modules/@chronodivide/game-api/package.json", "utf8"),
    ).version;
    if (expectedApi !== installedApi)
      throw new Error("Build the frozen source with its pinned SDK version");
    const result = await build({
      absWorkingDir: source,
      stdin: {
        contents: `
          import { WarbookBot, OBSERVATION_PROTOCOL } from './src/bridge.ts';
          import { POLICY_VERSION, POLICY_MODES } from './src/policy.ts';
          export const mode = ${JSON.stringify(mode)};
          if (!POLICY_MODES.includes(mode)) throw new Error('Unknown frozen policy mode');
          ${
            commanderModel
              ? `
          import { NeuralCommanderPolicy, prepareCommander } from './src/commander/network.ts';
          import { FullCommander } from './src/commander/controller.ts';
          import { CommanderTactics } from './src/commander/tactics.ts';
          import { ProgramProduction } from './src/control/program-production.ts';
          const artifact = ${JSON.stringify(launchModel)};
          await prepareCommander();
          const commanderPolicy = new NeuralCommanderPolicy(artifact);
          `
              : launchModel
                ? `
          import { ExperimentalLaunchProvider, LinearLaunchPolicy } from './src/learning/launch.ts';
          import { NeuralLaunchPolicy, prepareInference } from './src/learning/model.ts';
          ${operationModel ? `import { ExperimentalOperationProvider, ${contactModel ? "operationShape" : "OPERATION_SHAPE"} } from './src/learning/operation.ts';` : ""}
          ${maneuverModel ? "import { LOCAL_MAX_ACTIONS } from './src/learning/local-maneuvers.ts'; if (LOCAL_MAX_ACTIONS !== 77) throw new Error('Local maneuver source mismatch');" : ""}
          import { BastionStrategy } from './src/control/bastion-strategy.ts';
          import { PressureStrategy } from './src/control/pressure-strategy.ts';
          const artifact = ${JSON.stringify(launchModel)};
          await prepareInference();
          const launchPolicy = artifact.format === 'warbook-launch-linear-v1' ? new LinearLaunchPolicy(artifact) : new NeuralLaunchPolicy(artifact${operationModel ? (contactModel ? ", operationShape(artifact.schema)" : ", OPERATION_SHAPE") : ""});
          `
                : ""
          }
          export const policyVersion = POLICY_VERSION + ${JSON.stringify(commanderModel ? "-learned-commander" : launchModel ? (operationModel ? "-learned-" + launchModel.controlScope + (contactModel ? "-" + launchModel.contactInput : "") + (maneuverModel ? "-maneuver-" + launchModel.maneuverScope : "") : "-learned") : "")};
          export const observationProtocol = OBSERVATION_PROTOCOL;
          export const createBot = name => new WarbookBot(name, 'Americans', mode${commanderModel ? ", {strategy:new FullCommander(mode,commanderPolicy,'frozen',true),tactics:new CommanderTactics(),production:new ProgramProduction()}" : launchModel ? (operationModel ? `, {strategy: mode === 'pressure' ? new PressureStrategy(undefined,new ExperimentalOperationProvider(artifact.controlScope,'model','frozen',launchPolicy,true${contactModel ? ",artifact.contactInput" : ""}${maneuverModel ? ",artifact.maneuverScope" : ""})) : new BastionStrategy('bastion',undefined,new ExperimentalOperationProvider(artifact.controlScope,'model','frozen',launchPolicy,true${contactModel ? ",artifact.contactInput" : ""}${maneuverModel ? ",artifact.maneuverScope" : ""}))}` : `, { strategy: mode === 'pressure' ? new PressureStrategy(new ExperimentalLaunchProvider('model','frozen',launchPolicy,true)) : new BastionStrategy('bastion',new ExperimentalLaunchProvider('model','frozen',launchPolicy,true)) }`) : ""});
        `,
        resolveDir: source,
        sourcefile: "frozen-bot-entry.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      ...(launchModel ? { mainFields: ["module", "main"] } : {}),
      format: "esm",
      target: "node22",
      external: ["@chronodivide/game-api"],
      ...(launchModel
        ? {
            banner: {
              js: "import { createRequire as createNodeRequire } from 'node:module'; const require = createNodeRequire(import.meta.url);",
            },
          }
        : {}),
      metafile: true,
      write: false,
    });
    for (const output of Object.values(result.metafile!.outputs))
      for (const imported of output.imports)
        if (
          imported.path !== "@chronodivide/game-api" &&
          !(launchModel && isBuiltin(imported.path))
        )
          throw new Error(`Unfrozen bot dependency: ${imported.path}`);
    const code = result.outputFiles[0].contents;
    const sha256 = createHash("sha256").update(code).digest("hex");
    const directory = resolve(`dist/bots/${git}/${sha256}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${directory}/bot.mjs`, code);
    const module = await import(pathToFileURL(`${directory}/bot.mjs`).href);
    const layered = existsSync(`${source}/src/control/coordinator.ts`);
    const sourceHashes = layered
      ? Object.fromEntries(
          Object.keys(result.metafile!.inputs)
            .filter((path) => path !== "frozen-bot-entry.ts")
            .map((path) => [path, fileHash(resolve(source, path))]),
        )
      : undefined;
    const controlLayers =
      layered &&
      [
        "factory-exit",
        "bastion",
        "pressure",
        "cohort",
        "cohort-local",
      ].includes(mode)
        ? Object.fromEntries(
            Object.entries({
              strategy:
                mode === "factory-exit"
                  ? "strategy"
                  : mode === "pressure"
                    ? "pressure-strategy"
                    : "bastion-strategy",
              tactics:
                mode === "factory-exit"
                  ? "tactics"
                  : mode === "bastion" ||
                      mode === "pressure" ||
                      mode === "cohort-local"
                    ? "position-tactics"
                    : "cohort-tactics",
              production: "production",
              coordinator: "coordinator",
              contracts: "contracts",
            }).map(([part, file]) => [
              part,
              sourceHashes![`src/control/${file}.ts`],
            ]),
          )
        : undefined;
    const release: BotRelease = {
      format: "warbook-bot-v1",
      git,
      sha256,
      mode,
      policyVersion: module.policyVersion,
      ...(launchModel
        ? {
            launchModelSha256: modelSha,
            deterministicLaunch: true,
            ...(operationModel
              ? {
                  policySchema: launchModel.schema,
                  controlScope: launchModel.controlScope,
                  ...(contactModel
                    ? { contactInput: launchModel.contactInput }
                    : {}),
                  ...(maneuverModel
                    ? { maneuverScope: launchModel.maneuverScope }
                    : {}),
                }
              : {}),
          }
        : {}),
      observationProtocol: module.observationProtocol,
      ...engineHashes(),
      lockSha256,
      esbuild: esbuildVersion,
      ...(sourceHashes ? { sourceHashes } : {}),
      ...(controlLayers ? { controlLayers } : {}),
    };
    const metadata = JSON.stringify(release, null, 2);
    if (
      existsSync(`${directory}/release.json`) &&
      readFileSync(`${directory}/release.json`, "utf8") !== metadata
    )
      throw new Error(
        "An existing frozen release has different build metadata",
      );
    writeFileSync(`${directory}/release.json`, metadata);
    return { path: `${directory}/release.json`, ...release };
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      ref: { type: "string", default: "HEAD" },
      mode: { type: "string", default: "combined" },
      "launch-model": { type: "string" },
    },
  });
  console.log(
    JSON.stringify(
      await buildBot(values.ref!, values.mode!, values["launch-model"]),
    ),
  );
}
