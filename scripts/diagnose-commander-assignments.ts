import {
  createReadStream,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import {
  NeuralCommanderPolicy,
  prepareCommander,
} from "../src/commander/network.js";
import { type CommanderRecord } from "../src/commander/controller.js";
import {
  type CommanderAction,
  type CommanderWorld,
  TASK_KINDS,
} from "../src/commander/world.js";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    episodes: { type: "string" },
    out: { type: "string" },
    stride: { type: "string", default: "4" },
  },
});
if (!values.model || !values.episodes || !values.out)
  throw new Error("model, episodes and out are required");
const stride = Number(values.stride);
if (!Number.isInteger(stride) || stride < 1) throw new Error("Invalid stride");
const artifactText = readFileSync(values.model, "utf8");
await prepareCommander();
const model = new NeuralCommanderPolicy(JSON.parse(artifactText), true);

function canonical(a: CommanderAction, w: CommanderWorld): CommanderAction {
  if (model.encoding !== "graph-plan-v2") return a;
  return {
    ...a,
    units: a.units.map((selected, i) => {
      const old = w.previousRoles[i];
      const changed =
        old < 16 && a.kinds[old] !== 0 && a.kinds[old] !== w.previousKinds[old];
      return selected === 18 && changed
        ? old
        : selected === old && old !== 17 && !changed
          ? 18
          : selected;
    }),
  };
}

function job(
  w: CommanderWorld,
  a: CommanderAction,
  unit: number,
  selected = a.units[unit],
) {
  const role = selected === 18 ? w.previousRoles[unit] : selected;
  if (role >= 16)
    return {
      kind: ["reserve", "deploy", "keep", "native"][role - 16],
      goal: null,
    };
  const kind = a.kinds[role] || w.previousKinds[role];
  if (kind < 2) return { kind: "reserve", goal: null };
  const goal =
    kind === 10
      ? undefined
      : w.goalObjects[a.kinds[role] ? a.goals[role] : w.previousGoals[role]];
  return {
    kind: TASK_KINDS[kind],
    goal: goal
      ? [
          goal.x,
          goal.y,
          !!goal.onBridge,
          goal.ref ?? null,
          goal.kind === "native",
        ]
      : null,
  };
}

const argmax = (xs: number[]) =>
  xs.reduce((best, v, i) => (v > xs[best] ? i : best), 0);
const counter = () => ({
  units: 0,
  teacherContextCorrect: 0,
  modelContextCorrect: 0,
  desiredJobAvailable: 0,
  teacherCorrectModelWrong: 0,
  teacherMass: 0,
  modelMass: 0,
  labels: {} as Record<string, number>,
  teacherPredictions: {} as Record<string, number>,
  modelPredictions: {} as Record<string, number>,
});
const increment = (c: Record<string, number>, key: string) =>
  (c[key] = (c[key] ?? 0) + 1);
const episodes: any[] = [];
const examples: unknown[] = [];
try {
  for (const directory of JSON.parse(
    readFileSync(values.episodes, "utf8"),
  ) as string[]) {
    const manifest = JSON.parse(
      readFileSync(resolve(directory, "manifest.json"), "utf8"),
    );
    const actor = manifest.participants.find(
      (p: any) => p.role === "subject",
    ).name;
    const path = resolve(directory, "decisions.ndjson");
    const source = existsSync(path)
      ? createReadStream(path)
      : createReadStream(path + ".gz").pipe(createGunzip());
    const lines = createInterface({ input: source, crlfDelay: Infinity });
    let hidden = Array(model.hiddenSize).fill(0),
      frames = 0,
      previousTick = -75;
    const groups = { all: counter(), miners: counter(), tanks: counter() };
    for await (const line of lines) {
      if (
        !line.includes('"kind":"commander_decision"') ||
        !line.includes('"actor":' + JSON.stringify(actor))
      )
        continue;
      const record = JSON.parse(line).record as CommanderRecord;
      if (
        record.encoding !== model.encoding ||
        record.tick !== previousTick + 75 ||
        !record.teacherAction
      )
        throw new Error("Need continuous same-encoding DAgger episodes");
      previousTick = record.tick;
      const w = record.world;
      const own = model.predict(w, hidden, () => 0.5, true);
      if (frames++ % stride === 0) {
        const teacher = canonical(record.teacherAction, w);
        const guided = model.predict(w, hidden, () => 0.5, true, teacher);
        for (let i = 0; i < w.unitRefs.length; i++) {
          const desired = job(w, teacher, i),
            key = JSON.stringify(desired);
          const teacherProbs = guided.probabilities!.unit[i],
            ownProbs = own.probabilities!.unit[i];
          const givenTeacher = job(w, teacher, i, argmax(teacherProbs)),
            givenOwn = job(w, own.action, i);
          const teacherCorrect = JSON.stringify(givenTeacher) === key,
            ownCorrect = JSON.stringify(givenOwn) === key;
          const teacherMass = teacherProbs.reduce(
            (n, p, j) =>
              n + (JSON.stringify(job(w, teacher, i, j)) === key ? p : 0),
            0,
          );
          const ownMass = ownProbs.reduce(
            (n, p, j) =>
              n + (JSON.stringify(job(w, own.action, i, j)) === key ? p : 0),
            0,
          );
          const categories = [groups.all];
          if (w.unitCapabilities[i].miner) categories.push(groups.miners);
          if (["MTNK", "HTNK"].includes(w.entityNames[w.unitIndices[i]]))
            categories.push(groups.tanks);
          for (const g of categories) {
            g.units++;
            g.teacherContextCorrect += Number(teacherCorrect);
            g.modelContextCorrect += Number(ownCorrect);
            g.desiredJobAvailable += Number(ownMass > 0);
            g.teacherCorrectModelWrong += Number(teacherCorrect && !ownCorrect);
            g.teacherMass += teacherMass;
            g.modelMass += ownMass;
            increment(g.labels, desired.kind);
            increment(g.teacherPredictions, givenTeacher.kind);
            increment(g.modelPredictions, givenOwn.kind);
          }
          if (
            w.unitCapabilities[i].miner &&
            !ownCorrect &&
            examples.length < 30
          )
            examples.push({
              directory,
              tick: record.tick,
              ref: w.unitRefs[i],
              desired,
              givenTeacher,
              givenOwn,
              teacherMass,
              ownMass,
            });
        }
      }
      hidden = own.hidden;
    }
    episodes.push({ directory, frames, groups });
    console.log(
      JSON.stringify({
        episode: episodes.length,
        frames,
        miners: groups.miners,
      }),
    );
  }
} finally {
  model.dispose();
}
writeFileSync(
  values.out,
  JSON.stringify(
    {
      model: resolve(values.model),
      modelSha256: createHash("sha256").update(artifactText).digest("hex"),
      stride,
      scope:
        "Same recorded legal worlds, continuous memory recomputed with the tested checkpoint; teacher-conditioned versus free upstream plan. Development/off-policy diagnosis, not closed-loop strength or unseen evaluation.",
      episodes,
      examples,
    },
    null,
    2,
  ) + "\n",
);
