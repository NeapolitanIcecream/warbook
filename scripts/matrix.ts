import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildBot } from "./build-bot.js";

interface Source {
  ref: string;
  mode: string;
}
interface NativeOpponent {
  native: "supalosa";
}
interface Plan {
  purpose: string;
  subjects: Record<string, Source>;
  opponents: Record<string, Source | NativeOpponent>;
  maps: string[];
  rounds: number;
  factors?: unknown;
}
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" } },
});
if (positionals.length !== 1 || !values.out)
  throw new Error(
    "Usage: matrix.ts <frozen-source plan.json> --out <new run directory>",
  );
const plan: Plan = JSON.parse(readFileSync(positionals[0], "utf8"));
if (
  !Number.isInteger(plan.rounds) ||
  plan.rounds < 1 ||
  plan.rounds > 1000 ||
  !plan.maps.length
)
  throw new Error("Invalid matrix size");
for (const label of [
  ...Object.keys(plan.subjects),
  ...Object.keys(plan.opponents),
  ...plan.maps,
])
  if (!/^[A-Za-z0-9_.-]+$/.test(label))
    throw new Error("Matrix labels must be simple directory names");
const root = resolve(values.out);
if (existsSync(root) && readdirSync(root).length)
  throw new Error("Refusing to overwrite an existing experiment");
mkdirSync(root, { recursive: true });
const subjects: Record<string, string> = {};
const opponents: Record<string, string | NativeOpponent> = {};
for (const [label, source] of Object.entries(plan.subjects))
  subjects[label] = (await buildBot(source.ref, source.mode)).path;
for (const [label, source] of Object.entries(plan.opponents)) {
  if ("native" in source) {
    if (source.native !== "supalosa")
      throw new Error("Unknown native opponent");
    opponents[label] = source;
  } else opponents[label] = (await buildBot(source.ref, source.mode)).path;
}
writeFileSync(
  `${root}/plan.json`,
  JSON.stringify(
    {
      ...plan,
      sourcePlan: plan,
      subjects,
      opponents,
      units: 0,
      weights: "equal opponents and maps",
      limits: { ticks: 54000, seconds: 180 },
      slots: "alternate per round",
      subjectOrder: "reverse on alternate rounds",
      randomness: "uncontrolled new games",
    },
    null,
    2,
  ),
);
const rows: unknown[] = [];
for (const map of plan.maps)
  for (const [opponent, opponentRelease] of Object.entries(opponents))
    for (let round = 0; round < plan.rounds; round++) {
      const entries = Object.entries(subjects);
      if (round % 2) entries.reverse();
      for (const [subject, release] of entries) {
        const directory = resolve(root, map, opponent, `${round}-${subject}`);
        mkdirSync(directory, { recursive: true });
        const args = [
          "--env-file-if-exists=.env",
          "--import",
          "./src/engine-diagnostics.mjs",
          "--import",
          "tsx",
          "src/runner.ts",
          "--units",
          "0",
          "--actor-release",
          release,
          ...(typeof opponentRelease === "string"
            ? ["--opponent-release", opponentRelease]
            : ["--opponent", opponentRelease.native]),
          "--map",
          map,
          "--out",
          directory,
          ...(round % 2 ? ["--swap"] : []),
        ];
        try {
          const output = execFileSync(process.execPath, args, {
            encoding: "utf8",
            maxBuffer: 8 * 1024 * 1024,
            timeout: 200000,
          });
          writeFileSync(`${directory}/console.log`, output);
          const result = JSON.parse(
            readFileSync(`${directory}/result.json`, "utf8"),
          );
          const row = {
            map,
            opponent,
            round,
            subject,
            dir: directory,
            swapped: round % 2 === 1,
            stop: result.stopReason,
            clean: result.cleanCompletionVerified,
            winner: result.outcome?.survivor,
            tick: result.tick,
            seconds: result.wallSeconds,
          };
          rows.push(row);
          writeFileSync(
            `${root}/summary.json`,
            JSON.stringify({ rows }, null, 2),
          );
          console.log(JSON.stringify(row));
        } catch (error) {
          const failure = error as any;
          writeFileSync(
            `${directory}/console.log`,
            String(failure.stdout ?? "") +
              "\n" +
              String(failure.stderr ?? error),
          );
          rows.push({
            map,
            opponent,
            round,
            subject,
            dir: directory,
            error: String(error),
          });
          writeFileSync(
            `${root}/summary.json`,
            JSON.stringify({ rows }, null, 2),
          );
          throw error;
        }
      }
    }
