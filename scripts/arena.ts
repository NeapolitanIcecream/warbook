import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { NativeArenaPolicy, runArena } from "../src/arena.js";
import { ArmorArenaPolicy } from "../src/tactical/arena-policy.js";
import {
  NeuralTacticalPolicy,
  prepareTactical,
} from "../src/tactical/network.js";
const { values } = parseArgs({
  options: {
    map: { type: "string", default: "mp06t2.map" },
    tanks: { type: "string", default: "4" },
    units: { type: "string", default: "20" },
    out: { type: "string", default: "runs/arena-first" },
    model: { type: "string" },
    opponent: { type: "string", default: "focus" },
    "opponent-model": { type: "string" },
    teacher: { type: "boolean", default: false },
    deterministic: { type: "boolean", default: false },
    seed: { type: "string", default: "0" },
    swap: { type: "boolean", default: false },
  },
});
const out = resolve(values.out!);
mkdirSync(out, { recursive: true });
const begin = performance.now();
if (!["focus", "attack-move"].includes(values.opponent!))
  throw new Error("Invalid arena opponent");
const networks: NeuralTacticalPolicy[] = [];
const network = async (path: string | undefined) => {
  if (!path) return undefined;
  await prepareTactical();
  const n = new NeuralTacticalPolicy(JSON.parse(readFileSync(path, "utf8")));
  networks.push(n);
  return n;
};
const actor = await network(values.model),
  opponent = await network(values["opponent-model"]);
try {
  const result = await runArena({
    mixDir: resolve(process.env.MIX_DIR ?? "assets/ra2"),
    map: values.map!,
    tanks: Number(values.tanks),
    unitCount: Number(values.units),
    swap: values.swap,
    policies: [
      actor || values.teacher
        ? new ArmorArenaPolicy(actor, values.seed, values.deterministic)
        : new NativeArenaPolicy("attack-move"),
      opponent
        ? new ArmorArenaPolicy(opponent, values.seed + "opponent", true)
        : new NativeArenaPolicy(values.opponent as "focus" | "attack-move"),
    ],
    record: (side, observation, decision) =>
      appendFileSync(
        out + "/decisions.ndjson",
        JSON.stringify({ side, observation, ...decision }) + "\n",
      ),
  });
  const digest = (p: string | undefined) =>
    p ? createHash("sha256").update(readFileSync(p)).digest("hex") : undefined;
  const report = {
    ...result,
    actorModelSha256: digest(values.model),
    opponentModelSha256: digest(values["opponent-model"]),
    actor: actor ? "policy" : values.teacher ? "teacher" : "attack-move",
    opponent: opponent ? "policy" : values.opponent,
    deterministic: values.deterministic,
    seed: values.seed,
    wallSeconds: (performance.now() - begin) / 1000,
  };
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
} finally {
  networks.forEach((n) => n.dispose());
}
