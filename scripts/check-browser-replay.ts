import * as api from "@chronodivide/game-api";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const directory = resolve(process.argv[2]);
const expected = JSON.parse(readFileSync(`${directory}/result.json`, "utf8"));
const rows = readFileSync("runs/player/browser.ndjson", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const browser = rows
  .flatMap((row) => (row.port === 8644 ? row.events : []))
  .filter(
    (event) =>
      event.kind === "game_end" &&
      event.players.some(
        (p: { name: string }) => p.name === expected.stats[0].name,
      ),
  )
  .at(-1);
if (!browser) throw new Error("No corresponding browser end event");
await api.cdapi.init(resolve(process.env.MIX_DIR ?? "assets/ra2"));
const game = await api.cdapi.loadReplay(
  api.Replay.parse(readFileSync(expected.replay.file, "utf8")),
);
let node: unknown;
try {
  (
    api as unknown as {
      warbookCaptureEnd: (
        game: unknown,
        names: string[],
        callback: (event: unknown) => void,
      ) => void;
    }
  ).warbookCaptureEnd(
    game,
    expected.stats.map((p: { name: string }) => p.name),
    (event) => (node = event),
  );
  while (!game.isFinished()) await game.update();
} finally {
  game.dispose();
}
const comparable = {
  tick: browser.tick,
  players: browser.players.map(
    (p: { name: string; defeated: boolean; credits: number }) => ({
      name: p.name,
      defeated: p.defeated,
      credits: p.credits,
    }),
  ),
};
const matched = JSON.stringify(node) === JSON.stringify(comparable);
const result = {
  comparison: "same synchronous Game.onEnd boundary in both runtimes",
  matched,
  node,
  browser: comparable,
  loopReturnTick: expected.tick,
};
writeFileSync(
  `${directory}/browser-replay-check.json`,
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
if (!matched) process.exitCode = 1;
