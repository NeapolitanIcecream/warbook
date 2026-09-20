import { Bot } from "@chronodivide/game-api";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Observation, Intent } from "./model.js";
import type { Trace } from "./bridge.js";

export interface DrivenBot extends Bot {
  mode: string;
  autoTick: boolean;
  trace?: (event: Trace) => void;
  observation?: Observation;
  observe(): Observation;
  decide(observation: Observation): Intent[];
  submit(intents: Intent[]): void;
}

export interface BotRelease {
  format: "warbook-bot-v1";
  git: string;
  sha256: string;
  mode: string;
  policyVersion: string;
  observationProtocol: string;
  launchModelSha256?: string;
  deterministicLaunch?: boolean;
  apiSha256: string;
  resourceSha256: string;
  lockSha256: string;
  esbuild: string;
  sourceHashes?: Record<string, string>;
  controlLayers?: Record<string, string>;
}

export const fileHash = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

export function engineHashes() {
  return {
    apiSha256: fileHash("node_modules/@chronodivide/game-api/dist/index.js"),
    resourceSha256: fileHash(
      "node_modules/@chronodivide/game-api/dist/res/ra2cd.mix",
    ),
  };
}

export async function loadBotRelease(
  path: string,
  name: string | ((release: BotRelease) => string),
) {
  const release: BotRelease = JSON.parse(readFileSync(path, "utf8"));
  const file = resolve(dirname(path), "bot.mjs");
  if (release.format !== "warbook-bot-v1" || fileHash(file) !== release.sha256)
    throw new Error("Frozen bot artifact hash mismatch or unsupported format");
  const hashes = engineHashes();
  if (
    hashes.apiSha256 !== release.apiSha256 ||
    hashes.resourceSha256 !== release.resourceSha256
  )
    throw new Error(
      "Frozen bot dependencies differ from the running environment",
    );
  const module = await import(pathToFileURL(file).href);
  if (
    module.policyVersion !== release.policyVersion ||
    module.observationProtocol !== release.observationProtocol ||
    module.mode !== release.mode
  )
    throw new Error("Frozen bot metadata differs from its code");
  const bot: DrivenBot = module.createBot(
    typeof name === "function" ? name(release) : name,
  );
  if (
    !(bot instanceof Bot) ||
    bot.autoTick !== false ||
    !["observe", "decide", "submit"].every(
      (key) => typeof (bot as any)[key] === "function",
    )
  )
    throw new Error(
      "Frozen bot must use the same SDK and synchronous driver contract",
    );
  return { bot, release };
}
