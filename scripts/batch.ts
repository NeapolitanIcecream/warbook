import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    rounds: { type: "string", default: "8" },
    modes: { type: "string", default: "baseline,combined" },
    opponent: { type: "string", default: "supalosa" },
    map: { type: "string", default: "mp03t4.map" },
    out: { type: "string" },
  },
});
const rounds = Number(values.rounds);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000)
  throw new Error("rounds must be 1..1000");
const modes = values.modes!.split(",");
const root = resolve(
  values.out ?? `runs/batch-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
mkdirSync(root, { recursive: true });
const started = performance.now();
const rows: unknown[] = [];
writeFileSync(
  `${root}/plan.json`,
  JSON.stringify(
    {
      purpose: "development screening; independent unseeded games",
      rounds,
      modes,
      map: values.map,
      opponent: values.opponent,
      units: 0,
      tickLimit: 54000,
      wallLimitPerGame: 180,
      rule: "one clean engine-ended survivor; all other outcomes separately retained",
    },
    null,
    2,
  ),
);
for (let round = 0; round < rounds; round++)
  for (const mode of modes) {
    const dir = `${root}/${String(round).padStart(3, "0")}-${mode}`;
    mkdirSync(dir, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [
        "--env-file-if-exists=.env",
        "--import",
        "./src/engine-diagnostics.mjs",
        "--import",
        "tsx",
        "src/runner.ts",
        "--units",
        "0",
        "--map",
        values.map!,
        "--mode",
        mode,
        "--opponent",
        values.opponent!,
        "--out",
        dir,
      ],
      { encoding: "utf8", timeout: 200000, maxBuffer: 8 * 1024 * 1024 },
    );
    writeFileSync(`${dir}/console.log`, result.stdout + "\n" + result.stderr);
    let outcome: any;
    try {
      outcome = JSON.parse(readFileSync(`${dir}/result.json`, "utf8"));
    } catch {
      outcome = {
        stopReason: "runner_process_failure",
        error: String(result.error ?? result.stderr),
        cleanCompletionVerified: false,
      };
    }
    const row = {
      round,
      mode,
      dir,
      exitCode: result.status,
      stopReason: outcome.stopReason,
      clean: outcome.cleanCompletionVerified,
      winner: outcome.outcome?.survivor,
      tick: outcome.tick,
      wallSeconds: outcome.wallSeconds,
    };
    rows.push(row);
    writeFileSync(
      `${root}/summary.json`,
      JSON.stringify(
        { rows, wallSeconds: (performance.now() - started) / 1000 },
        null,
        2,
      ),
    );
    console.log(JSON.stringify(row));
    if (result.status !== 0) {
      console.error(
        "Batch stopped after a process error; the failed run and partial summary are retained.",
      );
      process.exit(1);
    }
  }
