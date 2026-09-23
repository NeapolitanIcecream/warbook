import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { NativeArenaPolicy, runArena } from "../src/arena.js";
const { values } = parseArgs({
  options: {
    map: { type: "string", default: "mp06t2.map" },
    tanks: { type: "string", default: "4" },
    units: { type: "string", default: "20" },
    out: { type: "string", default: "runs/arena-first" },
  },
});
const out = resolve(values.out!);
mkdirSync(out, { recursive: true });
const begin = performance.now();
try {
  const result = await runArena({
    mixDir: resolve(process.env.MIX_DIR ?? "assets/ra2"),
    map: values.map!,
    tanks: Number(values.tanks),
    unitCount: Number(values.units),
    policies: [
      new NativeArenaPolicy("attack-move"),
      new NativeArenaPolicy("focus"),
    ],
    record: (side, observation, decision) =>
      appendFileSync(
        out + "/decisions.ndjson",
        JSON.stringify({ side, observation, ...decision }) + "\n",
      ),
  });
  const report = { ...result, wallSeconds: (performance.now() - begin) / 1000 };
  writeFileSync(out + "/result.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  writeFileSync(
    out + "/failure.json",
    JSON.stringify(
      { error: String(error), wallSeconds: (performance.now() - begin) / 1000 },
      null,
      2,
    ),
  );
  throw error;
}
