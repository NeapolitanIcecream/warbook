import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { POLICY_VERSION, POLICY_MODES } from "../src/policy.js";
import { PINNED_CLIENT, SDK_RESOURCE_SHA } from "../src/player/client.js";
mkdirSync("dist/player", { recursive: true });
const mode = process.env.PLAYER_POLICY ?? "factory-exit";
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
  define: { __WARBOOK_POLICY__: JSON.stringify(mode) },
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
            "export const { Bot, ObjectType, OrderType, QueueStatus } = globalThis.WarbookEngineApi;",
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
writeFileSync(`${directory}/bot.js`, code);
const release = {
  clientVersion: PINNED_CLIENT.version,
  sdkResourceSha256: SDK_RESOURCE_SHA,
  sha256,
  version: POLICY_VERSION,
  mode,
  git: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
};
writeFileSync(`${directory}/release.json`, JSON.stringify(release, null, 2));
writeFileSync("dist/player/current.json", JSON.stringify(release, null, 2));
console.log(JSON.stringify(release));
