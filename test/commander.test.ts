import { test } from "node:test";
import assert from "node:assert/strict";
import type { Observation, Unit } from "../src/model.js";
import { ProgramProduction } from "../src/control/program-production.js";
import { shouldScanPlacement } from "../src/commander/placement-clock.js";
import { ProgramController } from "../src/commander/program.js";
import { CommanderTactics } from "../src/commander/tactics.js";
import {
  FullCommander,
  type CommanderPolicy,
} from "../src/commander/controller.js";
import {
  buildWorld,
  ContactMemory,
  keepAction,
  RESERVE,
  UNASSIGNED,
  KEEP_UNIT,
} from "../src/commander/world.js";
import type { ProgramProductionPlan } from "../src/control/contracts.js";

const unit = (ref: string, extra: Partial<Unit> = {}): Unit => ({
  ref,
  name: "MTNK",
  type: 7,
  x: 20,
  y: 20,
  hp: 300,
  maxHp: 300,
  width: 1,
  height: 1,
  mobile: true,
  idle: false,
  harvester: false,
  mcv: false,
  yard: false,
  refinery: false,
  combat: true,
  ...extra,
});
function observation(): Observation {
  return {
    tick: 0,
    side: 0,
    credits: 10000,
    power: { total: 0, drain: 100, isLowPower: true },
    home: { x: 20, y: 20 },
    starts: [
      { x: 20, y: 20 },
      { x: 80, y: 80 },
    ],
    own: [],
    enemies: [],
    products: [
      { name: "MTNK", type: 7, queue: 3, cost: 700 },
      { name: "GAPOWR", type: 2, queue: 0, cost: 800 },
    ],
    queues: Array.from({ length: 6 }, (_, type) => ({
      type,
      status: 0,
      size: 0,
      items: [],
    })),
    buildSites: [],
  };
}
const production = (): ProgramProductionPlan => ({
  id: "production",
  revision: 1,
  deploymentUnits: [],
  program: { queues: [], placements: [], repair: [], sell: [] },
});

test("DAgger labels learner states without silently applying the expert action", () => {
  const o = observation();
  o.own = [unit("mcv", { name: "AMCV", mcv: true, combat: false })];
  const policy: CommanderPolicy = {
    hiddenSize: 128,
    predict(w, hidden, _random, _deterministic, forced) {
      return {
        action: forced ?? keepAction(w),
        logp: -2,
        value: 0.5,
        entropy: 1,
        hidden: [...hidden],
      };
    },
  };
  const assessment = { army: [], observedArmor: 0, armorOutsideFactories: 0 };
  const learner = new FullCommander("bastion", policy, "test", true, 0, 0);
  const plan = learner.plan(o, assessment);
  assert.deepEqual(plan.production.deploymentUnits, []);
  assert.deepEqual(learner.record?.action.units, [KEEP_UNIT]);
  assert.deepEqual(learner.record?.teacherAction?.units, [17]);
  assert.equal(learner.record?.executionSource, "policy");
  assert.equal(learner.record?.logp, -2);
  const expert = new FullCommander("bastion", policy, "test", true, 0, 1);
  assert.deepEqual(expert.plan(o, assessment).production.deploymentUnits, [
    "mcv",
  ]);
  assert.equal(expert.record?.executionSource, "teacher");
  assert.equal(expert.record?.logp, 0);
});

test("an explicit plan does not invent power, repairs or army production", () => {
  const o = observation();
  o.own = [
    unit("yard", {
      type: 2,
      name: "GACNST",
      yard: true,
      repairable: true,
      hp: 10,
    }),
  ];
  const p = production();
  p.program.queues = [
    { queue: 3, mode: "run", product: "MTNK", target: 1, reserve: 0 },
  ];
  const result = new ProgramProduction().control(o, p, []);
  assert.deepEqual(
    result.intents.map((i) => (i.kind === "queue" ? i.product.name : i.kind)),
    ["MTNK"],
  );
});

test("queue pause, resume, cancellation and a chosen cash floor remain explicit", () => {
  const o = observation(),
    p = production(),
    controller = new ProgramProduction();
  o.queues[3] = {
    type: 3,
    status: 1,
    size: 1,
    items: [{ name: "MTNK", quantity: 1 }],
  };
  p.program.queues = [{ queue: 3, mode: "pause", target: 0, reserve: 0 }];
  assert.equal(
    (controller.control(o, p, []).intents[0] as any).action,
    "pause",
  );
  o.queues[3].status = 2;
  p.program.queues = [
    { queue: 3, mode: "run", product: "MTNK", target: 1, reserve: 0 },
  ];
  assert.equal(
    (controller.control(o, p, []).intents[0] as any).action,
    "resume",
  );
  p.program.queues = [{ queue: 3, mode: "cancel", target: 0, reserve: 0 }];
  assert.equal(
    (controller.control(o, p, []).intents[0] as any).action,
    "cancel",
  );
  o.queues[3].status = 1;
  o.credits = 20;
  p.program.queues = [
    { queue: 3, mode: "run", target: 2, product: "MTNK", reserve: 500 },
  ];
  assert.equal(
    (controller.control(o, p, []).intents[0] as any).action,
    "pause",
  );
});

test("KEEP on an unassigned new miner preserves native harvesting", () => {
  const o = observation();
  o.own = [unit("miner", { name: "CMIN", harvester: true })];
  const controller = new ProgramController(),
    memory = new ContactMemory(),
    w = buildWorld(o, controller.state, memory);
  assert.equal(w.previousRoles[0], UNASSIGNED);
  controller.apply(o, w, keepAction(w));
  const plan = controller.plan(o),
    tactics = new CommanderTactics();
  assert.deepEqual(
    [plan.combat, ...plan.additionalCombat!].flatMap(
      (m) => tactics.control(o, m, []).intents,
    ),
    [],
  );
  const a = keepAction(w);
  a.units[0] = RESERVE;
  controller.apply(o, w, a);
  const held = controller.plan(o);
  assert.equal(
    [held.combat, ...held.additionalCombat!]
      .flatMap((m) => tactics.control(o, m, []).intents)
      .filter((i) => i.kind === "stop").length,
    1,
  );
});

test("native harvesting is a representable task before any ore region is observed", () => {
  const o = observation();
  o.own = [unit("miner", { name: "CMIN", harvester: true })];
  const controller = new ProgramController(),
    w = buildWorld(o, controller.state, new ContactMemory()),
    a = keepAction(w);
  a.kinds[0] = 8;
  a.goals[0] = 0;
  a.units[0] = 0;
  controller.apply(o, w, a);
  const m = controller.plan(o).combat;
  assert.equal(m.kind, "harvest");
  assert.equal(m.destination, undefined);
  assert.deepEqual(new CommanderTactics().control(o, m, []).intents, []);
});

test("the strategy can assign individuals, split forces and cancel only one group", () => {
  const o = observation();
  o.own = [unit("a"), unit("b"), unit("c")];
  const c = new ProgramController(),
    m = new ContactMemory();
  let w = buildWorld(o, c.state, m),
    a = keepAction(w);
  a.kinds[0] = 3;
  a.kinds[1] = 4;
  a.goals[0] = w.goalObjects.findIndex((g) => g.kind === "start" && g.x === 80);
  a.goals[1] = 1;
  a.units = [0, 1, 0];
  c.apply(o, w, a);
  let p = c.plan(o);
  assert.deepEqual(p.combat.units, ["a", "c"]);
  assert.deepEqual(p.additionalCombat![0].units, ["b"]);
  o.tick = 75;
  w = buildWorld(o, c.state, m);
  a = keepAction(w);
  a.kinds[0] = 1;
  a.units = [RESERVE, KEEP_UNIT, RESERVE];
  c.apply(o, w, a);
  p = c.plan(o);
  assert.deepEqual(p.additionalCombat![0].units, ["b"]);
  assert.deepEqual(p.combat.units, []);
});

test("building placement executes the chosen observed footprint, without a new ranking", () => {
  const o = observation(),
    p = production();
  o.queues[0] = {
    type: 0,
    status: 3,
    size: 1,
    items: [{ name: "GAPOWR", quantity: 1 }],
  };
  o.buildSites = [{ name: "GAPOWR", x: 21, y: 21 }];
  o.placementChoices = [...o.buildSites, { name: "GAPOWR", x: 30, y: 30 }];
  p.program.placements = [o.placementChoices[1]];
  assert.deepEqual(new ProgramProduction().control(o, p, []).intents, [
    { kind: "place", name: "GAPOWR", x: 30, y: 30 },
  ]);
  o.queues[0].status = 0;
  o.queues[0].size = 0;
  o.queues[0].items = [];
  assert.deepEqual(new ProgramProduction().control(o, p, []).intents, []);
});

test("world features remain finite with absent optional flags and include spatially distinct enemies", () => {
  const o = observation();
  o.own = [unit("a")];
  o.enemies = [
    {
      ref: "e",
      name: "HTNK",
      type: 7,
      x: 23,
      y: 20,
      hp: 400,
      maxHp: 400,
      observedTick: 0,
    },
  ];
  const c = new ProgramController(),
    m = new ContactMemory();
  m.observe(o);
  const near = buildWorld(o, c.state, m);
  o.enemies[0] = { ...o.enemies[0], x: 70 };
  m.observe(o);
  const far = buildWorld(o, c.state, m);
  assert.notDeepEqual(near.entities, far.entities);
  assert(near.entityEdges.length > far.entityEdges.length);
  for (const rows of [
    near.entities,
    near.regions,
    near.goals,
    near.products,
    near.tasks,
    near.queues,
  ])
    assert(rows.flat().every(Number.isFinite));
});

test("semantic goal metadata cannot overwrite a native movement command kind", () => {
  const o = observation();
  o.own = [unit("tank")];
  const p = new ProgramController(),
    w = buildWorld(o, p.state, new ContactMemory()),
    a = keepAction(w);
  a.kinds[0] = 5;
  a.goals[0] = w.goalObjects.findIndex((g) => g.kind === "start" && g.x === 80);
  a.units[0] = 0;
  p.apply(o, w, a);
  const mission = p.plan(o).combat;
  assert.deepEqual(mission.destination, { x: 80, y: 80 });
  const intents = new CommanderTactics().control(o, mission, []).intents;
  assert(intents.some((i) => i.kind === "move"));
  assert(intents.every((i) => i.kind !== ("start" as any)));
});

test("a teacher's targetless capture recovery remains a move home when other capture targets exist", () => {
  const o = observation();
  o.own = [
    unit("engineer", {
      name: "ENGINEER",
      type: 3,
      engineer: true,
      x: 40,
      y: 40,
    }),
  ];
  o.techBuildings = [{ ref: "oil", name: "CAOILD", x: 60, y: 60 }];
  const p = new ProgramController(),
    w = buildWorld(o, p.state, new ContactMemory());
  const desired = {
    tick: 0,
    combat: {
      id: "capture-income",
      revision: 1,
      kind: "capture" as const,
      units: ["engineer"],
      destination: o.home,
      objective: "capture-visible-income",
      engagement: { allowCrush: false },
    },
    production: production(),
  };
  const a = p.teacherAction(o, w, desired);
  assert.equal(a.kinds[0], 5);
  p.apply(o, w, a);
  assert.equal(p.plan(o).combat.kind, "withdraw");
  assert.deepEqual(p.plan(o).combat.destination, o.home);
});

test("Ready fortifications reach every subsequent strategy clock regardless of Ready offset", () => {
  for (const ready of [72, 75, 78]) {
    let last = -30;
    const offered: number[] = [];
    for (let tick = ready; tick <= 1500; tick += 3)
      if (shouldScanPlacement(true, true, tick, last)) {
        last = tick;
        offered.push(tick);
      }
    assert.equal(offered[0], Math.ceil(ready / 75) * 75);
    assert(offered.every((t, i) => !i || t - offered[i - 1] === 75));
  }
});

test("harvest, explicit hold, and the same harvest task produce Gather, Stop, Gather", () => {
  const o = observation();
  o.own = [unit("miner", { name: "CMIN", harvester: true })];
  const t = new CommanderTactics();
  const harvest = {
    id: "same-slot",
    revision: 1,
    kind: "harvest" as const,
    units: ["miner"],
    destination: { x: 30, y: 30 },
    objective: "mine",
    engagement: { allowCrush: false },
  };
  assert.equal(t.control(o, harvest, []).intents[0]?.kind, "gather");
  o.tick += 3;
  assert.equal(t.control(o, harvest, []).intents.length, 0);
  o.tick += 75;
  assert.equal(
    t.control(o, { ...harvest, kind: "hold", objective: "explicit-hold" }, [])
      .intents[0]?.kind,
    "stop",
  );
  o.own[0].idle = true;
  o.tick += 75;
  assert.equal(t.control(o, harvest, []).intents[0]?.kind, "gather");
  o.tick += 3;
  assert.equal(t.control(o, harvest, []).intents.length, 0);
});
