import { build } from "esbuild";
import { mkdirSync } from "node:fs";
mkdirSync("dist/player", { recursive: true });
await build({
  entryPoints: ["src/player/integration.ts"],
  outfile: "dist/player/bot.js",
  bundle: true,
  format: "iife",
  globalName: "Warbook",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
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
