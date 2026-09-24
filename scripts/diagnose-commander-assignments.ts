import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readJournal } from "../src/journal-reader.js";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NeuralCommanderPolicy,
  prepareCommander,
} from "../src/commander/network.js";
import { type CommanderRecord } from "../src/commander/controller.js";
import {
  actionEdits,
  commanderRoleMask,
  type EncodedCommanderAction,
} from "../src/commander/action-mask.js";
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
  if (model.encoding === "graph-plan-v1") return a;
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
      engagement: null,
    };
  const kind = a.kinds[role] || w.previousKinds[role];
  if (kind < 2) return { kind: "reserve", goal: null, engagement: null };
  const goal =
    kind === 10
      ? undefined
      : w.goalObjects[a.kinds[role] ? a.goals[role] : w.previousGoals[role]];
  return {
    kind: TASK_KINDS[kind],
    engagement:
      kind === 10
        ? 0
        : a.kinds[role]
          ? a.engagement[role]
          : w.tasks[role][20] + 2 * w.tasks[role][21] + 4 * w.tasks[role][24],
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
function nearby(a: ReturnType<typeof job>, b: ReturnType<typeof job>) {
  return (
    a.kind === b.kind &&
    (!a.goal || !b.goal
      ? a.goal === b.goal
      : a.goal[2] === b.goal[2] &&
        a.goal[4] === b.goal[4] &&
        Math.hypot(
          Number(a.goal[0]) - Number(b.goal[0]),
          Number(a.goal[1]) - Number(b.goal[1]),
        ) <= 8)
  );
}
const counter = () => ({
  units: 0,
  teacherContextCorrect: 0,
  modelContextCorrect: 0,
  desiredJobAvailable: 0,
  teacherCorrectModelWrong: 0,
  teacherContextKindCorrect: 0,
  modelContextKindCorrect: 0,
  desiredKindAvailable: 0,
  teacherContextNearby: 0,
  modelContextNearby: 0,
  policyContextCorrect: 0,
  policyContextKindCorrect: 0,
  policyContextNearby: 0,
  teacherMass: 0,
  modelMass: 0,
  labels: {} as Record<string, number>,
  teacherPredictions: {} as Record<string, number>,
  modelPredictions: {} as Record<string, number>,
});
const increment = (c: Record<string, number>, key: string) =>
  (c[key] = (c[key] ?? 0) + 1);
const conditionCounter = () => ({
  units: 0,
  correct: 0,
  kindCorrect: 0,
  kindAbsent: 0,
  semanticJobAbsent: 0,
  memberWrongWithJobAvailable: 0,
});
const conditions = () =>
  Object.fromEntries(
    [
      "teacher-production_teacher-tasks",
      "teacher-production_model-tasks",
      "model-production_teacher-tasks",
      "model-production_model-tasks",
    ].map((name) => [
      name,
      {
        all: conditionCounter(),
        miners: conditionCounter(),
        tanks: conditionCounter(),
      },
    ]),
  );
const episodes: any[] = [];
const examples: unknown[] = [];
const exampleCounts = { miner: 0, tank: 0 };
const reviewMembers = (
  a: EncodedCommanderAction,
  w: CommanderWorld,
): EncodedCommanderAction => {
  if (model.encoding !== "graph-plan-v3") return a;
  const edits = [...(a.edits ?? actionEdits(a))];
  edits[2] = Number(w.unitRefs.length > 0);
  return { ...a, edits };
};
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
    const source = readJournal(path);
    const lines = createInterface({ input: source, crlfDelay: Infinity });
    let hidden = Array(model.hiddenSize).fill(0),
      frames = 0,
      previousTick = -75;
    const groups = { all: counter(), miners: counter(), tanks: counter() };
    const upstreamConditions = conditions();
    for await (const line of lines) {
      if (
        !line.includes('"kind":"commander_decision"') ||
        !line.includes('"actor":' + JSON.stringify(actor))
      )
        continue;
      const record = JSON.parse(line).record as CommanderRecord;
      if (
        (record.encoding !== model.encoding &&
          !(
            model.encoding === "graph-plan-v3" &&
            record.encoding === "graph-plan-v2"
          )) ||
        record.tick !== previousTick + 75 ||
        !record.teacherAction
      )
        throw new Error("Need continuous same-encoding DAgger episodes");
      previousTick = record.tick;
      const w = record.world;
      const own = model.predict(w, hidden, () => 0.5, true);
      if (frames++ % stride === 0) {
        const teacher = reviewMembers(canonical(record.teacherAction, w), w);
        const guided = model.predict(
          w,
          hidden,
          () => 0.5,
          true,
          reviewMembers({ ...teacher, units: [] }, w),
        );
        const ownHead =
          model.encoding === "graph-plan-v3"
            ? model.predict(
                w,
                hidden,
                () => 0.5,
                true,
                reviewMembers(own.action, w),
              )
            : own;
        // Production also reaches task queries. Cross it separately from task content.
        const teacherProductionModelTasks: EncodedCommanderAction = {
          ...own.action,
          queues: teacher.queues,
          amounts: teacher.amounts,
          cash: teacher.cash,
          kinds: [],
          goals: [],
          engagement: [],
          units: [],
          ...(own.action.edits
            ? {
                edits: [
                  teacher.edits![0],
                  own.action.edits[1],
                  1,
                  ...own.action.edits.slice(3),
                ],
              }
            : {}),
        };
        const modelProductionTeacherTasks: EncodedCommanderAction = {
          ...teacher,
          queues: own.action.queues,
          amounts: own.action.amounts,
          cash: own.action.cash,
          units: [],
          ...(teacher.edits
            ? {
                edits: [
                  own.action.edits![0],
                  teacher.edits[1],
                  1,
                  ...teacher.edits.slice(3),
                ],
              }
            : {}),
        };
        const crossed = {
          "teacher-production_teacher-tasks": guided,
          "teacher-production_model-tasks": model.predict(
            w,
            hidden,
            () => 0.5,
            true,
            reviewMembers(teacherProductionModelTasks, w),
          ),
          "model-production_teacher-tasks": model.predict(
            w,
            hidden,
            () => 0.5,
            true,
            reviewMembers(modelProductionTeacherTasks, w),
          ),
          "model-production_model-tasks": ownHead,
        };
        for (let i = 0; i < w.unitRefs.length; i++) {
          const desired = job(w, teacher, i),
            key = JSON.stringify(desired);
          const teacherProbs = guided.probabilities!.unit[i],
            ownProbs = ownHead.probabilities!.unit[i];
          const givenTeacher = job(w, teacher, i, argmax(teacherProbs)),
            givenOwn = job(w, own.action, i, argmax(ownProbs));
          const policy = job(w, own.action, i);
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
          const tank = ["MTNK", "HTNK"].includes(
            w.entityNames[w.unitIndices[i]],
          );
          if (w.unitCapabilities[i].miner) categories.push(groups.miners);
          if (tank) categories.push(groups.tanks);
          const legal = commanderRoleMask(
            w,
            i,
            own.action.kinds,
            model.encoding,
          );
          const kindAvailable = legal.some(
            (allowed, j) =>
              allowed && job(w, own.action, i, j).kind === desired.kind,
          );
          const jobAvailable = legal.some(
            (allowed, j) =>
              allowed && JSON.stringify(job(w, own.action, i, j)) === key,
          );
          for (const [name, prediction] of Object.entries(crossed)) {
            const mask = commanderRoleMask(
              w,
              i,
              prediction.action.kinds,
              model.encoding,
            );
            const available = mask.some(
              (allowed, j) =>
                allowed &&
                JSON.stringify(job(w, prediction.action, i, j)) === key,
            );
            const typeAvailable = mask.some(
              (allowed, j) =>
                allowed &&
                job(w, prediction.action, i, j).kind === desired.kind,
            );
            const selected = job(
              w,
              prediction.action,
              i,
              argmax(prediction.probabilities!.unit[i]),
            );
            const correct = JSON.stringify(selected) === key;
            const c = upstreamConditions[name];
            for (const category of [
              c.all,
              ...(w.unitCapabilities[i].miner ? [c.miners] : []),
              ...(tank ? [c.tanks] : []),
            ]) {
              category.units++;
              category.correct += Number(correct);
              category.kindCorrect += Number(selected.kind === desired.kind);
              category.kindAbsent += Number(!typeAvailable);
              category.semanticJobAbsent += Number(typeAvailable && !available);
              category.memberWrongWithJobAvailable += Number(
                available && !correct,
              );
            }
          }
          for (const g of categories) {
            g.units++;
            g.teacherContextCorrect += Number(teacherCorrect);
            g.modelContextCorrect += Number(ownCorrect);
            g.desiredJobAvailable += Number(jobAvailable);
            g.teacherCorrectModelWrong += Number(teacherCorrect && !ownCorrect);
            g.teacherContextKindCorrect += Number(
              givenTeacher.kind === desired.kind,
            );
            g.modelContextKindCorrect += Number(givenOwn.kind === desired.kind);
            g.desiredKindAvailable += Number(kindAvailable);
            g.teacherContextNearby += Number(nearby(givenTeacher, desired));
            g.modelContextNearby += Number(nearby(givenOwn, desired));
            g.policyContextCorrect += Number(JSON.stringify(policy) === key);
            g.policyContextKindCorrect += Number(policy.kind === desired.kind);
            g.policyContextNearby += Number(nearby(policy, desired));
            g.teacherMass += teacherMass;
            g.modelMass += ownMass;
            increment(g.labels, desired.kind);
            increment(g.teacherPredictions, givenTeacher.kind);
            increment(g.modelPredictions, givenOwn.kind);
          }
          const category = w.unitCapabilities[i].miner
            ? "miner"
            : tank
              ? "tank"
              : undefined;
          if (category && !ownCorrect && exampleCounts[category]++ < 15)
            examples.push({
              category,
              directory,
              tick: record.tick,
              ref: w.unitRefs[i],
              desired,
              givenTeacher,
              givenOwn,
              policy,
              teacherMass,
              ownMass,
            });
        }
      }
      hidden = own.hidden;
    }
    episodes.push({ directory, frames, groups, upstreamConditions });
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
      scriptSha256: createHash("sha256")
        .update(readFileSync(fileURLToPath(import.meta.url)))
        .digest("hex"),
      stride,
      scope:
        "Same recorded legal worlds and continuous checkpoint memory. Four crossed production/task conditions; task generation uses the selected production context. Member review is open for head diagnostics; actual policy scores are separate. Availability uses legal masks, not nonzero floating probabilities. Exact job includes native identity and engagement flags; nearby/kind scores are looser diagnostics, not training equivalence or closed-loop strength.",
      episodes,
      examples,
    },
    null,
    2,
  ) + "\n",
);
