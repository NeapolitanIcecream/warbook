import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JournalBehavior,
  ReplayBehavior,
  renderBehavior,
  type ReplayUnit,
} from "../src/analysis/match-behavior.js";
import type { Observation, Unit } from "../src/model.js";
import type { StrategicPlan } from "../src/control/contracts.js";

const armor = (ref: string, x: number, y: number): Unit => ({
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
  idle: true,
  harvester: false,
  mcv: false,
  yard: false,
  refinery: false,
  combat: true,
});
function observation(tick: number, shift = 0): Observation {
  return {
    tick,
    side: 0,
    credits: 0,
    power: { total: 100, drain: 50, isLowPower: false },
    home: { x: 0, y: 0 },
    starts: [],
    own: [armor("a", 20 + shift, 20), armor("b", 21 + shift, 20)],
    enemies: [],
    products: [],
    queues: [],
    buildSites: [],
  };
}
function plan(kind: "advance" | "defend", tick = 0): StrategicPlan {
  return {
    tick,
    combat: {
      id: "main",
      revision: 1,
      kind,
      units: ["a", "b"],
      destination: { x: 50, y: 50 },
      objective: "enemy-base",
      engagement: { allowCrush: true },
    },
    production: {} as StrategicPlan["production"],
  };
}
const replayUnit = (
  id: number,
  overrides: Partial<ReplayUnit> = {},
): ReplayUnit => ({
  id,
  name: "E1",
  x: 20,
  y: 20,
  hp: 125,
  building: false,
  defense: false,
  infantry: true,
  armor: false,
  combat: true,
  airborne: false,
  deployed: true,
  range: 5,
  width: 1,
  height: 1,
  weapons: [
    { name: "M60", cooldown: 0 },
    { name: "Para", cooldown: 0 },
  ],
  ...overrides,
});

test("an advance plan and repeated move orders do not establish progress", () => {
  const journal = new JournalBehavior();
  journal.onPlan(plan("advance"));
  for (let tick = 0; tick <= 1200; tick += 150) {
    journal.onOrder(tick, {
      kind: "move",
      task: "main",
      refs: ["a", "b"],
      x: 50,
      y: 50,
    });
    journal.onObservation(observation(tick));
  }
  const result = journal.finish();
  assert.equal(result.firstAdvance?.tick, 0);
  assert.equal(result.longestStalledMarch?.toTick, 1200);
  assert.equal(result.longestStalledMarch?.moveOrders, 9);
});

test("controller ownership counts native orders that have no optional human task tag", () => {
  const journal = new JournalBehavior();
  journal.onPlan(plan("advance"));
  journal.onOrder(3, { kind: "attackMove", refs: ["a"], x: 50, y: 50 }, "main");
  journal.onOrder(
    6,
    { kind: "attack", refs: ["a"], target: "enemy", task: "local-label" },
    "main",
  );
  journal.onOrder(
    9,
    { kind: "attackMove", refs: ["b"], x: 0, y: 0 },
    "reserve",
  );
  const result = journal.finish();
  assert.equal(result.advanceMoveOrders, 1);
  assert.equal(result.advanceCombatOrders, 2);
});

test("progress, an observation gap and a defense mission cannot be mislabeled as a stalled advance", () => {
  for (const condition of ["moving", "gap", "defending"]) {
    const journal = new JournalBehavior();
    journal.onPlan(plan(condition === "defending" ? "defend" : "advance"));
    for (let tick = 0; tick <= 1800; tick += condition === "gap" ? 600 : 150) {
      journal.onOrder(tick, {
        kind: "move",
        task: "main",
        refs: ["a", "b"],
        x: 50,
        y: 50,
      });
      journal.onObservation(
        observation(tick, condition === "moving" ? tick / 50 : 0),
      );
    }
    assert.equal(journal.finish().longestStalledMarch, undefined, condition);
  }
});

function defense(withFire: boolean) {
  const analysis = new ReplayBehavior();
  for (let tick = 0; tick < 450; tick += 3) {
    const infantry = Array.from({ length: 6 }, (_, i) =>
      replayUnit(i + 1, {
        x: withFire ? 3 : 20,
        y: withFire ? 2 : 20,
        weapons: [
          { name: "M60", cooldown: 0 },
          { name: "Para", cooldown: withFire ? 15 - (tick % 15) : 0 },
        ],
      }),
    );
    const base = replayUnit(100, {
      name: "GAREFN",
      x: 0,
      y: 0,
      building: true,
      infantry: false,
      combat: false,
      weapons: [],
      hp: 1000 - tick,
    });
    analysis.sample({
      tick,
      own: [base, ...infantry],
      opponent: [replayUnit(200, { x: 1, y: 2 })],
      visibleEnemyIds: [200],
    });
  }
  return analysis;
}

test("deployed defenders outside range are reported when a visible attack damages a building", () => {
  const result = defense(false).finish(new JournalBehavior().finish());
  assert.equal(result.defenseWindow?.infantryMin, 6);
  assert.equal(result.defenseWindow?.deployedMax, 6);
  assert.equal(result.defenseWindow?.infantryWithFiringSignals, 0);
  assert.equal(result.defenseWindow?.geometricRangeMax, 0);
  assert.ok(result.defenseWindow!.hpDecrease > 0);
});

test("deployed secondary-weapon fire is counted; deployment alone does not decide participation", () => {
  const result = defense(true).finish(new JournalBehavior().finish());
  assert.equal(result.defenseWindow?.infantryWithFiringSignals, 6);
  assert.equal(result.defenseWindow?.peakFiringUnitsIn30Ticks, 6);
});

test("missing historical plans remain unknown, and terminal units override the last periodic sample", () => {
  const result = defense(false).finish(new JournalBehavior().finish(), []);
  assert.deepEqual(result.finalOwn, {});
  assert.match(renderBehavior(result), /没有记录战略任务/);
  assert.doesNotMatch(renderBehavior(result), /未出现有兵力/);
});

test("damage to an enemy defense is distinguished from damage to economic buildings", () => {
  const analysis = new ReplayBehavior();
  for (const tick of [0, 3])
    analysis.sample({
      tick,
      own: [],
      visibleEnemyIds: [],
      opponent: [
        replayUnit(1, {
          name: "GAPILL",
          building: true,
          defense: true,
          hp: 100 - tick,
        }),
        replayUnit(2, { name: "GAREFN", building: true, hp: 100 }),
      ],
    });
  analysis.destroyed("opponent", { building: true, defense: true });
  assert.equal(
    analysis.finish(new JournalBehavior().finish()).opponentNonDefenseBuildings
      .observedHpDecrease,
    0,
  );
  analysis.destroyed("opponent", { building: true, defense: false });
  assert.equal(
    analysis.finish(new JournalBehavior().finish()).opponentNonDefenseBuildings
      .destructionEvents,
    1,
  );
});
