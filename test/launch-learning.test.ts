import { test } from "node:test";
import assert from "node:assert/strict";
import { Operations } from "../src/control/operations.js";
import { BastionStrategy } from "../src/control/bastion-strategy.js";
import { LocalCombat } from "../src/control/tactics.js";
import {
  LegacyLaunchProvider,
  type LegacyLaunchContext,
} from "../src/control/launch-provider.js";
import {
  ExperimentalLaunchProvider,
  buildLaunchSnapshot,
  GLOBAL_SIZE,
  CANDIDATE_SIZE,
  type LaunchPolicy,
  type LaunchSnapshot,
} from "../src/learning/launch.js";
import {
  prepareInference,
  NeuralLaunchPolicy,
  type LaunchModel,
} from "../src/learning/model.js";
import type { Observation, Unit, Contact } from "../src/model.js";
const unit = (ref: string, x = 2, y = 2): Unit => ({
  ref,
  name: "MTNK",
  type: 7,
  x,
  y,
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
  weaponRange: 5,
});
const enemy = (ref: string, x: number, type = 2): Contact => ({
  ref,
  name: type === 2 ? "GAWEAP" : "MTNK",
  type,
  x,
  y: 2,
  hp: type === 2 ? 1000 : 300,
  maxHp: type === 2 ? 1000 : 300,
  observedTick: 6000,
  weaponRange: type === 2 ? 0 : 5,
});
const observation = (): Observation => ({
  tick: 6000,
  side: 0,
  credits: 2000,
  power: { total: 200, drain: 100, isLowPower: false },
  home: { x: 0, y: 0 },
  starts: [
    { x: 0, y: 0 },
    { x: 90, y: 2 },
  ],
  own: Array.from({ length: 8 }, (_, i) =>
    unit(`u${i}`, 2 + (i % 3), 2 + Math.floor(i / 3)),
  ),
  enemies: [enemy("base", 90)],
  products: [],
  queues: [],
  buildSites: [],
});
function context(o: Observation): LegacyLaunchContext {
  const operations = new Operations();
  operations.observe(o, []);
  return {
    observation: o,
    operations,
    ready: o.own.filter((u) => u.combat),
    reserve: o.own.filter((u) => u.combat),
    active: false,
    slotFree: true,
    protectNow: false,
    nextLaunchTick: 0,
    firstForceFunded: true,
    hasScouts: true,
    launchSize: 6,
    armor: "MTNK",
  };
}
const choose = (f: (s: LaunchSnapshot) => number): LaunchPolicy => ({
  predict(s) {
    const i = f(s);
    return {
      probabilities: s.actions.map((_, j) => Number(i === j)),
      value: 0.5,
    };
  },
});

test("launch menu is bounded, order/reference neutral, and does not mask unfavorable fights", () => {
  const o = observation();
  o.own = [unit("a")];
  o.enemies.push(
    ...Array.from({ length: 20 }, (_, i) => enemy(`e${i}`, 85 + (i % 3), 7)),
  );
  const c = context(o);
  assert.equal(new LegacyLaunchProvider().choose(c), undefined);
  const s = buildLaunchSnapshot(c);
  assert(s.actions.length > 1 && s.actions.length <= 33);
  assert.equal(s.global.length, GLOBAL_SIZE);
  assert(
    s.candidates.every(
      (x) => x.length === CANDIDATE_SIZE && x.every(Number.isFinite),
    ),
  );
  const other = context({
    ...o,
    own: o.own.map((u) => ({ ...u, ref: "renamed" })).reverse(),
    enemies: o.enemies
      .map((e) => ({ ...e, ref: `renamed-${e.ref}` }))
      .reverse(),
  });
  const t = buildLaunchSnapshot(other);
  assert.deepEqual(t.global, s.global);
  assert.deepEqual(t.candidates, s.candidates);
  const p = new ExperimentalLaunchProvider(
    "model",
    "case",
    choose(() => 1),
    true,
  );
  assert.equal(p.choose(c)?.units.length, 1);
});

test("known disconnected targets are excluded, while unknown connectivity remains a possible action", () => {
  const o = observation();
  o.launchGeometry = [
    ...o.own.map((u) => ({ ...u, region: 0 })),
    { x: 90, y: 2, region: 1 },
  ];
  assert.equal(buildLaunchSnapshot(context(o)).actions.length, 1);
  o.launchGeometry = undefined;
  assert(buildLaunchSnapshot(context(o)).actions.length > 1);
});

test("partial wave commitment is not immediately filled from withheld stock", () => {
  const o = observation(),
    provider = new ExperimentalLaunchProvider(
      "model",
      "partial",
      choose((s) => s.actions.findIndex((a) => a.units.length === 3)),
      true,
    );
  const strategy = new BastionStrategy("bastion", provider),
    tactics = new LocalCombat();
  const plan = () =>
    strategy.plan(o, tactics.assess(o, strategy.assessmentRequest(o)));
  const first = plan();
  assert.equal(first.combat.kind, "advance");
  assert.equal(first.combat.units.length, 3);
  assert.equal(
    first.additionalCombat?.find((m) => m.id === "reinforcements")?.units
      .length ?? 0,
    0,
  );
  o.tick += 3;
  const second = plan();
  assert.equal(second.combat.units.length, 3);
  assert.equal(
    second.additionalCombat?.find((m) => m.id === "reinforcements")?.units
      .length ?? 0,
    0,
  );
});

test("KEEP leaves the wave uncommitted and does not create revision churn", () => {
  const o = observation(),
    provider = new ExperimentalLaunchProvider(
      "model",
      "keep",
      choose(() => 0),
      true,
    ),
    strategy = new BastionStrategy("bastion", provider),
    tactics = new LocalCombat();
  const plan = () =>
    strategy.plan(o, tactics.assess(o, strategy.assessmentRequest(o)));
  const first = plan();
  o.tick += 75;
  const second = plan();
  assert.equal(first.combat.kind, "assemble");
  assert.equal(second.combat.revision, first.combat.revision);
});

test("remembered objective does not drift to another visible building", () => {
  const o = observation(),
    ops = new Operations();
  ops.observe(o, []);
  ops.active = {
    point: { x: 90, y: 2 },
    objectiveRef: "base",
    objectiveKey: "base",
    origin: "experiment",
    reason: "attack-opportunity",
    defenders: 0,
    productionArrivals: 0,
    travelSeconds: 0,
  };
  o.tick += 3;
  o.enemies = [enemy("other", 15)];
  ops.observe(o, []);
  const actual = ops.target(o, o.own);
  assert.deepEqual(actual?.point, { x: 90, y: 2 });
  assert.equal(actual?.ref, undefined);
});

test("launch alone is not new defense evidence; a new hit can still request relief", () => {
  const o = observation();
  o.own.push({
    ...unit("refinery", 0, 0),
    name: "GAREFN",
    type: 2,
    width: 3,
    height: 3,
    combat: false,
    refinery: true,
    mobile: false,
    hp: 1000,
    maxHp: 1000,
  });
  o.enemies.push(enemy("intruder", 11, 7));
  const provider = new ExperimentalLaunchProvider(
    "model",
    "relief",
    choose((s) => {
      let best = 0;
      for (let i = 1; i < s.actions.length; i++)
        if (s.actions[i].units.length > s.actions[best].units.length) best = i;
      return best;
    }),
    true,
  );
  const strategy = new BastionStrategy("bastion", provider),
    tactics = new LocalCombat();
  const plan = () =>
    strategy.plan(o, tactics.assess(o, strategy.assessmentRequest(o)));
  const first = plan();
  assert.equal(first.combat.units.length, 8);
  o.tick += 3;
  const held = plan();
  assert.equal(held.combat.units.length, 8);
  assert(!held.additionalCombat?.some((m) => m.id === "base-relief"));
  o.tick += 3;
  o.own.find((u) => u.ref === "refinery")!.hp -= 20;
  const hit = plan();
  assert(
    hit.additionalCombat?.some(
      (m) => m.id === "base-relief" && m.units.length > 0,
    ),
  );
});

test("model export dimensions match synchronous shared CPU inference", async () => {
  await prepareInference();
  const dense = (input: number) => ({
    input,
    output: 1,
    weights: Array(input).fill(0),
    bias: [0],
  });
  const m: LaunchModel = {
    format: "warbook-launch-model-v1",
    schema: "launch-v1",
    policyVersion: "test",
    actor: [dense(GLOBAL_SIZE + CANDIDATE_SIZE)],
    critic: [dense(GLOBAL_SIZE)],
  };
  const model = new NeuralLaunchPolicy(m),
    s = buildLaunchSnapshot(context(observation()));
  const p = model.predict(s);
  assert.equal(p.probabilities.length, s.actions.length);
  assert(Math.abs(p.probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-6);
  assert.equal(p.value, 0.5);
  model.dispose();
});

test("frontier compression preserves a known yard and the intended unexplored start", () => {
  const o = observation();
  o.armySearchPoints = Array.from({ length: 100 }, (_, i) => ({
    x: 10 + (i % 10) * 8,
    y: 10 + Math.floor(i / 10) * 8,
  }));
  o.enemies = [
    { ...enemy("yard", 81), name: "GACNST", y: 86 },
    { ...enemy("power", 78), name: "GAPOWR", y: 87 },
  ];
  assert(buildLaunchSnapshot(context(o)).targets.some((t) => t.ref === "yard"));
  o.enemies = [];
  const c = context(o);
  c.searchGoal = { x: 90, y: 2 };
  assert(
    buildLaunchSnapshot(c).targets.some(
      (t) => t.point.x === 90 && t.point.y === 2,
    ),
  );
});
