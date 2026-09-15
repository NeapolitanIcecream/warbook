import * as api from "@chronodivide/game-api";
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";

const assetPath = "/dist/spbots.min.js?v=0.84.0";
export const OFFICIAL_BOT_SHA =
  "d935bc55a2eb94252a116b50fe05620b663677dc3f8e144f594db11ac0b7cd56";
export interface NativeOpponent extends api.Bot {
  mode: string;
  step(game: api.GameApi): void;
}

/** Load the one AMD module shipped by the pinned official client, without changing its code. */
export function createOfficialOpponent(name: string): NativeOpponent {
  const key = createHash("sha256").update(assetPath).digest("hex");
  const file =
    process.env.OFFICIAL_BOT_PATH ?? resolve(`work/client-cache/${key}`);
  const source = readFileSync(file, "utf8");
  if (createHash("sha256").update(source).digest("hex") !== OFFICIAL_BOT_SHA)
    throw new Error("Official opponent source hash mismatch");
  let library:
    | {
        version: string;
        SupalosaBot: new (
          name: string,
          country: string,
          allies: string[],
          logging: boolean,
        ) => api.Bot;
      }
    | undefined;
  runInNewContext(
    source,
    {
      THREE,
      console,
      define: (
        name: string,
        deps: string[],
        factory: (dependency: typeof api) => typeof library,
      ) => {
        if (
          name !== "SPBots" ||
          deps.length !== 1 ||
          deps[0] !== "@chronodivide/game-api"
        )
          throw new Error("Unexpected official AMD module contract");
        library = factory(api);
      },
    },
    { timeout: 1000, filename: "official-spbots-0.84.0.js" },
  );
  if (!library || library.version !== "0.84.0")
    throw new Error("Official opponent version mismatch");
  class ControlledOfficial extends library.SupalosaBot {
    readonly mode = "official-spbots-0.84.0-" + OFFICIAL_BOT_SHA.slice(0, 12);
    override onGameTick(_game: api.GameApi): void {}
    step(game: api.GameApi): void {
      super.onGameTick(game);
    }
  }
  const bot = new ControlledOfficial(name, "Americans", [], false);
  if (!(bot instanceof api.Bot))
    throw new Error("Official opponent loaded a different API instance");
  return bot;
}
