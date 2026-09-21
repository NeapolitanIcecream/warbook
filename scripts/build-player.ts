import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { POLICY_VERSION, POLICY_MODES } from "../src/policy.js";
import { PINNED_CLIENT, SDK_RESOURCE_SHA } from "../src/player/client.js";
mkdirSync("dist/player", { recursive: true });
const mode = process.env.PLAYER_POLICY ?? "bastion";
const modelPath = process.env.PLAYER_LAUNCH_MODEL;
const launchModel = modelPath
  ? JSON.parse(readFileSync(modelPath, "utf8"))
  : null;
const modelSha256 = modelPath
  ? createHash("sha256").update(readFileSync(modelPath)).digest("hex")
  : undefined;
if (!POLICY_MODES.some((value) => value === mode))
  throw new Error("Unknown player policy");
const output = await build({
  entryPoints: ["src/player/integration.ts"],
  outfile: "dist/player/bot.js",
  bundle: true,
  format: "iife",
  globalName: "Warbook",
  platform: "browser",
  target: "es2022",
  sourcemap: "inline",
  write: false,
  define: {
    __WARBOOK_POLICY__: JSON.stringify(mode),
    __WARBOOK_LAUNCH_MODEL__: JSON.stringify(launchModel),
  },
  plugins: [
    {
      name: "official-api",
      setup(b) {
        b.onResolve({ filter: /^@chronodivide\/game-api$/ }, () => ({
          path: "official-api",
          namespace: "official",
        }));
        b.onLoad({ filter: /.*/, namespace: "official" }, () => ({
          contents:
            "export const { Bot, ObjectType, OrderType, QueueStatus, TerrainType } = globalThis.WarbookEngineApi;",
          loader: "js",
        }));
      },
    },
  ],
});
const code = output.outputFiles[0].contents;
const sha256 = createHash("sha256").update(code).digest("hex");
const directory = `dist/player/${sha256}`;
mkdirSync(directory, { recursive: true });
const bundlePath = `${directory}/bot.js`;
if (existsSync(bundlePath)) {
  if (
    createHash("sha256").update(readFileSync(bundlePath)).digest("hex") !==
    sha256
  )
    throw new Error("Existing player bundle hash mismatch");
} else writeFileSync(bundlePath, code);
let release = {
  clientVersion: PINNED_CLIENT.version,
  sdkResourceSha256: SDK_RESOURCE_SHA,
  sha256,
  version: POLICY_VERSION,
  mode: launchModel
    ? launchModel.schema === "operation-v2"
      ? "learned-" + launchModel.controlScope
      : "learned-launch"
    : mode,
  ...(launchModel ? { launchModelSha256: modelSha256, baseMode: mode } : {}),
  git: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
};
const manifestPath = `${directory}/release.json`;
if (existsSync(manifestPath)) {
  const original = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const key of [
    "clientVersion",
    "sdkResourceSha256",
    "sha256",
    "version",
    "mode",
  ] as const)
    if (original[key] !== release[key])
      throw new Error("Player metadata differs from its immutable bundle");
  // Docs-only commits can rebuild identical bytes. Keep the recorded origin of those bytes.
  release = original;
} else writeFileSync(manifestPath, JSON.stringify(release, null, 2));
writeFileSync("dist/player/current.json", JSON.stringify(release, null, 2));
console.log(JSON.stringify(release));
