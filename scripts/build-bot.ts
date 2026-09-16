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
import { parseArgs } from "node:util";
import { engineHashes, fileHash, type BotRelease } from "../src/bot-release.js";

export async function buildBot(ref: string, mode = "combined") {
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
          export const policyVersion = POLICY_VERSION;
          export const observationProtocol = OBSERVATION_PROTOCOL;
          export const createBot = name => new WarbookBot(name, 'Americans', mode);
        `,
        resolveDir: source,
        sourcefile: "frozen-bot-entry.ts",
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      packages: "external",
      metafile: true,
      write: false,
    });
    for (const output of Object.values(result.metafile!.outputs))
      for (const imported of output.imports)
        if (imported.path !== "@chronodivide/game-api")
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
      layered && ["factory-exit", "bastion"].includes(mode)
        ? Object.fromEntries(
            [
              "strategy",
              "tactics",
              "production",
              "coordinator",
              "contracts",
            ].map((part) => [
              part,
              sourceHashes![
                `src/control/${mode === "bastion" && part === "strategy" ? "bastion-strategy" : mode === "bastion" && part === "tactics" ? "position-tactics" : part}.ts`
              ],
            ]),
          )
        : undefined;
    const release: BotRelease = {
      format: "warbook-bot-v1",
      git,
      sha256,
      mode,
      policyVersion: module.policyVersion,
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
    },
  });
  console.log(JSON.stringify(await buildBot(values.ref!, values.mode!)));
}
