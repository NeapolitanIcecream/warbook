import { test } from "node:test";
import assert from "node:assert/strict";
import type { Intent, Observation, Unit } from "../src/model.js";
import { Commander } from "../src/policy.js";
import { LegacyCommander } from "../src/legacy-policy.js";
import { GroupedAdvance, LocalCombat } from "../src/control/tactics.js";
import { ControlCoordinator } from "../src/control/coordinator.js";
import type {
  CombatMission,
  ControlResult,
  ExecutionEvidence,
} from "../src/control/contracts.js";
import { DecisionShadow, ShadowMismatch } from "../src/analysis/shadow.js";

const tank = (ref: string, x = 76, y = 41): Unit => ({
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
  crusher: true,
});
const building = (ref: string, name: string, x: number, y: number): Unit => ({
  ...tank(ref, x, y),
  name,
  type: 2,
  width: 5,
  height: 3,
  mobile: false,
  combat: false,
});
function observation(): Observation {
  return {
    tick: 5886,
    side: 0,
    credits: 2000,
    power: { total: 200, drain: 100, isLowPower: false },
    home: { x: 71, y: 37 },
    starts: [
      { x: 71, y: 37 },
      { x: 38, y: 73 },
    ],
    own: [
      { ...tank("mcv"), name: "AMCV", mcv: true, combat: false },
      building("power", "GAPOWR", 60, 30),
      building("refinery", "GAREFN", 60, 40),
      building("barracks", "GAPILE", 60, 50),
      building("factory", "GAWEAP", 74, 37),
      tank("a"),
      tank("b", 76, 42),
      tank("c", 78, 41),
      tank("d", 76, 38),
    ],
    enemies: [],
    products: [
      { name: "GAREFN", cost: 2000, type: 2, queue: 0 },
      { name: "CMIN", cost: 1400, type: 7, queue: 3 },
      { name: "MTNK", cost: 700, type: 7, queue: 3 },
      { name: "E1", cost: 200, type: 3, queue: 2 },
    ],
    queues: [0, 2, 3].map((type) => ({ type, status: 0, size: 0, items: [] })),
    buildSites: [],
  };
}
const economic = (intents: readonly Intent[]) =>
  intents.filter((i) => ["queue", "place", "deploy"].includes(i.kind));

test("layered opening preserves the published sequence through exit casualties and air contacts", () => {
  const old = new LegacyCommander("factory-exit"),
    current = new Commander("factory-exit", { tactics: new LocalCombat() });
  let o = observation();
  for (const tick of [5886, 5889, 5892, 5904, 5952, 6000, 6450, 9000]) {
    o = { ...o, tick };
    if (tick === 5904) o.own = o.own.filter((u) => u.ref !== "a");
    if (tick === 5952)
      o.own = o.own.map((u) => (u.ref === "d" ? { ...u, x: 78, y: 40 } : u));
    if (tick === 6000)
      o.enemies = [
        {
          ref: "air",
          name: "JUMPJET",
          type: 3,
          x: 80,
          y: 44,
          hp: 125,
          maxHp: 125,
          observedTick: tick,
          airborne: true,
        },
      ];
    if (tick === 6450) o.enemies = [];
    assert.deepEqual(
      current.decide(structuredClone(o)),
      old.decide(structuredClone(o)),
      `tick ${tick}`,
    );
  }
});

test("a replacement tactic can change combat commands without changing strategy or production", () => {
  class IdleTactics extends LocalCombat {
    override readonly id = "test-idle-tactics";
    override control(
      o: Observation,
      mission: CombatMission,
      evidence: readonly ExecutionEvidence[],
    ): ControlResult {
      const result = super.control(o, mission, evidence);
      return { ...result, intents: [] };
    }
  }
  const normal = new Commander("factory-exit"),
    changed = new Commander("factory-exit", { tactics: new IdleTactics() });
  const o = observation();
  const a = normal.decide(o),
    b = changed.decide(o);
  assert.deepEqual(normal.controlPlan, changed.controlPlan);
  assert.deepEqual(economic(a), economic(b));
  assert(a.some((i) => i.kind === "attackMove"));
  assert(!b.some((i) => i.kind === "attackMove"));
});

test("tactics cannot commandeer production-owned units or submit purchases", () => {
  for (const intent of [
    { kind: "move", refs: ["mcv"], x: 50, y: 50 },
    { kind: "queue", product: { name: "MTNK", type: 7, queue: 3, cost: 700 } },
  ] as Intent[]) {
    class ConflictingTactics extends LocalCombat {
      override control(
        o: Observation,
        mission: CombatMission,
        evidence: readonly ExecutionEvidence[],
      ): ControlResult {
        return { ...super.control(o, mission, evidence), intents: [intent] };
      }
    }
    assert.throws(
      () =>
        new Commander("factory-exit", {
          tactics: new ConflictingTactics(),
        }).decide(observation()),
      /ownership|cannot spend/,
    );
  }
});

test("mission revisions remain stable across observation reordering but reject superseded results", () => {
  const c = new ControlCoordinator();
  const o = observation();
  c.decide(o);
  const first = c.plan!;
  const reordered = { ...o, tick: o.tick + 3, own: [...o.own].reverse() };
  c.decide(reordered);
  assert.equal(c.plan!.combat.revision, first.combat.revision);
  const changed = {
    ...reordered,
    tick: o.tick + 6,
    own: reordered.own.map((u) => (u.ref === "d" ? { ...u, x: 78, y: 40 } : u)),
  };
  const stale = c.components.tactics.control(reordered, first.combat, []);
  c.decide(changed);
  assert(c.plan!.combat.revision > first.combat.revision);
  assert.throws(
    () => c.compile(changed, c.plan!, [stale]),
    /Stale task result/,
  );
  assert.throws(() => c.compile(changed, first, []), /Stale control plan/);
});

test("execution evidence reaches its owning task without treating movement as completion", () => {
  const c = new Commander("factory-exit"),
    o = observation();
  const intents = c.decide(o);
  const movement = intents.find((i) => i.kind === "attackMove")!;
  const origin = c.intentOrigin(movement)!;
  const evidence: ExecutionEvidence = {
    origin,
    intentId: "observed-movement",
    basedOnTick: o.tick,
    observedTick: o.tick + 3,
    effect: "position_changed_not_arrival",
    unresolved: false,
  };
  c.acceptEffect(evidence);
  c.decide({ ...o, tick: o.tick + 3 });
  assert.deepEqual(c.controlReport!.combat.executionEvidence, [evidence]);
  assert.equal(c.controlReport!.combat.status, "waiting");
  assert.deepEqual(c.controlReport!.production.executionEvidence, []);
  c.acceptEffect({
    ...evidence,
    origin: { ...origin, revision: origin.revision - 1 },
  });
  c.decide({ ...o, tick: o.tick + 6 });
  assert.deepEqual(c.controlReport!.combat.executionEvidence, []);
});

test("decision shadow uses independent observation copies and fails on the first differing command", () => {
  const comparison = new DecisionShadow(),
    o = observation();
  let original: Observation | undefined;
  comparison.decide(
    o,
    (input) => {
      original = input;
      return [];
    },
    (input) => {
      assert.notEqual(input, original);
      assert.deepEqual(input, o);
      return [];
    },
  );
  assert.equal(comparison.summary().comparisons, 1);
  assert.throws(
    () =>
      comparison.decide(
        { ...o, tick: o.tick + 3 },
        () => [],
        () => [{ kind: "move", refs: ["a"], x: 30, y: 30 }],
      ),
    ShadowMismatch,
  );
  assert.equal(comparison.summary().mismatches, 1);
  assert.equal(comparison.summary().allComparedDecisionsMatched, false);
});

test("native marching groups preserve unit goals and production while keeping infantry and combat orders separate", () => {
  const o = observation();
  o.own = [
    ...o.own.map((u) => (u.ref === "d" ? { ...u, x: 78, y: 40 } : u)),
    { ...tank("gi", 76, 44), name: "E1", type: 3, crusher: false },
  ];
  const individual = new Commander("factory-exit", {
    tactics: new LocalCombat(),
  });
  const grouped = new Commander("factory-exit", {
    tactics: new GroupedAdvance(),
  });
  const before = individual.decide(o),
    after = grouped.decide(o);
  assert.deepEqual(individual.controlPlan, grouped.controlPlan);
  assert.deepEqual(economic(before), economic(after));
  const marching = after.filter(
    (i): i is Extract<Intent, { kind: "attackMove" | "move" }> =>
      i.kind === "attackMove",
  );
  assert.deepEqual(marching.map((i) => i.refs.length).sort(), [1, 4]);
  const expand = (intents: Intent[]) =>
    intents
      .flatMap<Intent>((i) =>
        "refs" in i ? i.refs.map((ref) => ({ ...i, refs: [ref] })) : [i],
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(expand(before), expand(after));
  const contact = {
    ...o,
    tick: o.tick + 90,
    enemies: [
      {
        ref: "enemy-gi",
        name: "E1",
        type: 3,
        x: 77,
        y: 44,
        hp: 125,
        maxHp: 125,
        observedTick: o.tick + 90,
      },
    ],
  };
  assert.deepEqual(individual.decide(contact), grouped.decide(contact));
});
