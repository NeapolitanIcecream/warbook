import { cdapi, Replay } from "@chronodivide/game-api";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(process.argv[2]);
const expected = JSON.parse(readFileSync(`${dir}/result.json`, "utf8"));
const path =
  typeof expected.replay === "string" ? expected.replay : expected.replay.file;
const replay = Replay.parse(readFileSync(path, "utf8"));
const start = performance.now();
await cdapi.init(resolve(process.env.MIX_DIR ?? "assets/ra2"));
const game = await cdapi.loadReplay(replay);
let error: string | undefined;
const timeline: unknown[] = [];
try {
  while (!game.isFinished() && performance.now() - start < 120000) {
    await game.update();
    if (game.getCurrentTick() % 1500 === 0)
      timeline.push({
        tick: game.getCurrentTick(),
        players: expected.stats.map((p: { name: string }) => ({
          name: p.name,
          credits: game.getPlayer(p.name).getPlayerData().credits,
          objects: game.gameApi
            .getVisibleUnits(p.name, "self")
            .map((id) => game.gameApi.getUnitData(id))
            .filter(Boolean)
            .reduce<Record<string, number>>(
              (r, u) => ((r[u!.name] = (r[u!.name] ?? 0) + 1), r),
              {},
            ),
        })),
      });
  }
} catch (e) {
  error = String(e);
}
const players = expected.stats.map((p: { name: string }) => {
  const actual = game.getPlayer(p.name);
  return {
    name: p.name,
    defeated: actual.isDefeated(),
    credits: actual.getPlayerData().credits,
  };
});
const matched =
  !error &&
  game.getCurrentTick() === expected.tick &&
  players.every((p: { name: string; defeated: boolean; credits: number }) => {
    const e = expected.stats.find((s: { name: string }) => s.name === p.name);
    return e.defeated === p.defeated && e.credits === p.credits;
  });
const result = {
  file: path,
  tick: game.getCurrentTick(),
  expectedTick: expected.tick,
  isFinished: game.isFinished(),
  players,
  matched,
  error,
  wallSeconds: (performance.now() - start) / 1000,
};
game.dispose();
writeFileSync(`${dir}/replay-check.json`, JSON.stringify(result, null, 2));
writeFileSync(`${dir}/replay-timeline.json`, JSON.stringify(timeline, null, 2));
console.log(JSON.stringify(result));
if (!matched) process.exitCode = 1;
