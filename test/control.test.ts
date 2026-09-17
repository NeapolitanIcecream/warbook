import { test } from "node:test";
import assert from "node:assert/strict";
import type { Intent, Observation, Unit } from "../src/model.js";
import { Commander } from "../src/policy.js";
import { LegacyCommander } from "../src/legacy-policy.js";
import { GroupedAdvance, LocalCombat } from "../src/control/tactics.js";
import { ControlCoordinator } from "../src/control/coordinator.js";
import { PositionTactics } from "../src/control/position-tactics.js";
import { DefenseAssignments } from "../src/control/defense-assignments.js";
import { Reconnaissance, ScoutTactics } from "../src/control/reconnaissance.js";
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

test("bastion keeps infantry at home and releases reinforcements as a separate batch", () => {
  const c = new Commander("bastion");
  const o = observation();
  const gi = { ...tank("gi", 67, 41), name: "E1", type: 3, crusher: false };
  o.own.push(gi);
  c.decide(o);
  assert.equal(c.controlPlan!.combat.kind, "defend");
  assert(!c.controlPlan!.combat.units.includes("gi"));
  assert.deepEqual(c.controlPlan!.additionalCombat![0].units, ["gi"]);
  o.own = o.own.filter((u) => u.name !== "MTNK");
  o.own.push(
    ...Array.from({ length: 8 }, (_, i) => tank(`wave-${i}`, 68 + (i % 3), 42)),
  );
  o.tick += 3;
  c.decide(o);
  assert.equal(c.controlPlan!.combat.kind, "advance");
  assert.equal(c.controlPlan!.combat.units.length, 8);
  o.own.push(tank("fresh", 68, 43));
  o.tick += 3;
  c.decide(o);
  assert.equal(c.controlPlan!.combat.units.length, 8);
  assert.deepEqual(
    c.controlPlan!.additionalCombat!.find((m) => m.id === "reserve-force")!
      .units,
    ["fresh"],
  );
  o.own.push(
    ...Array.from({ length: 3 }, (_, i) => tank(`fresh-${i}`, 68, 43)),
  );
  o.tick += 3;
  c.decide(o);
  assert.equal(
    c.controlPlan!.additionalCombat!.find((m) => m.id === "reinforcements")!
      .units.length,
    4,
  );
  assert(!c.controlPlan!.combat.units.includes("fresh"));
  o.tick += 3;
  c.decide(o);
  assert.equal(c.controlPlan!.combat.units.length, 12);
  assert(
    !c.controlPlan!.additionalCombat!.some((m) => m.id === "reinforcements"),
  );
});

test("a scout has independent ownership and does not replace a garrison infantry target", () => {
  const c = new Commander("bastion"),
    o = observation();
  o.own.push(
    { ...tank("dog", 70, 34), name: "ADOG", type: 3, crusher: false },
    ...[0, 1].map((i) => ({
      ...tank(`gi-${i}`, 70, 35),
      name: "E1",
      type: 3,
      crusher: false,
    })),
  );
  o.products.push({ name: "ADOG", cost: 200, type: 3, queue: 2 });
  const intents = c.decide(o),
    plan = c.controlPlan!;
  const scout = plan.additionalCombat!.find((m) => m.id === "recon")!;
  assert.deepEqual(scout.units, ["dog"]);
  assert.equal(scout.kind, "scout");
  assert.equal(plan.production.infantry.count, 6);
  assert(intents.some((i) => i.kind === "queue" && i.product.name === "E1"));
  assert.equal(
    [plan.combat, ...plan.additionalCombat!]
      .flatMap((m) => m.units)
      .filter((u) => u === "dog").length,
    1,
  );
  assert(intents.some((i) => i.kind === "move" && i.refs.includes("dog")));
});

test("scouts retreat from visible weapons without turning scouting into an attack", () => {
  const tactics = new ScoutTactics(),
    o = observation();
  const dog = { ...tank("dog", 20, 20), name: "ADOG", type: 3, crusher: false };
  o.own = [dog];
  const mission: CombatMission = {
    id: "recon",
    revision: 1,
    kind: "scout",
    units: [dog.ref],
    destination: { x: 60, y: 20 },
    objective: "reveal",
    engagement: { allowCrush: false },
  };
  assert.equal(tactics.control(o, mission, []).intents[0].kind, "move");
  o.tick += 60;
  dog.x = 24;
  o.enemies = [
    {
      ref: "enemy",
      name: "E1",
      type: 3,
      x: 30,
      y: 20,
      hp: 125,
      maxHp: 125,
      observedTick: o.tick,
      weaponRange: 5,
    },
  ];
  const result = tactics.control(o, mission, []);
  assert.equal(result.report.reason, "avoid-visible-threat");
  assert.deepEqual(result.intents[0], {
    kind: "move",
    refs: ["dog"],
    x: 20,
    y: 20,
    task: "recon",
  });
  o.tick += 180;
  dog.x = 20;
  o.enemies = [];
  assert.equal(
    tactics.control(o, mission, []).report.reason,
    "reveal-and-revisit",
  );
});

test("a retreat postpones only the attempted scouting route, then allows another route", () => {
  const recon = new Reconnaissance(),
    o = observation();
  const dog = { ...tank("dog", 0, 0), name: "ADOG", type: 3 };
  o.home = { x: 0, y: 0 };
  o.own = [dog];
  o.starts = [o.home, { x: 40, y: 0 }];
  o.scoutPoints = [{ x: 20, y: 20 }];
  assert.deepEqual(recon.destination(o, [dog]), { x: 40, y: 0 });
  const feedback = {
    additionalCombat: [
      { task: { id: "recon" }, reason: "avoid-visible-threat" },
    ],
  } as any;
  o.tick += 3;
  assert.equal(recon.destination(o, [dog], feedback), undefined);
  o.tick += 3;
  assert.equal(recon.destination(o, [dog], feedback), undefined);
  o.tick += 180;
  assert.deepEqual(recon.destination(o, [dog]), { x: 20, y: 20 });
});

test("bastion reforms after heavy losses without issuing the same unit to two tasks", () => {
  const c = new Commander("bastion"),
    o = observation();
  o.own = o.own.filter((u) => u.name !== "MTNK");
  o.own.push(
    ...Array.from({ length: 8 }, (_, i) => tank(`wave-${i}`, 68 + (i % 3), 42)),
  );
  c.decide(o);
  assert.equal(c.controlPlan!.combat.kind, "advance");
  o.own = o.own.filter(
    (u) => !u.ref.startsWith("wave-") || ["wave-0", "wave-1"].includes(u.ref),
  );
  o.tick += 3;
  c.decide(o);
  assert.equal(c.controlPlan!.combat.kind, "defend");
  const missions = [c.controlPlan!.combat, ...c.controlPlan!.additionalCombat!];
  const refs = missions.flatMap((m) => m.units);
  assert.equal(new Set(refs).size, refs.length);
});

test("a local counterattack window can release four ready tanks after observed armor pressure subsides", () => {
  const c = new Commander("bastion"),
    o = observation();
  o.own = o.own.filter((u) => u.name !== "MTNK");
  o.own.push(
    ...Array.from({ length: 4 }, (_, i) => tank(`wave-${i}`, 68 + (i % 3), 42)),
  );
  o.enemies = [
    {
      ref: "enemy-a",
      name: "MTNK",
      type: 7,
      x: 70,
      y: 45,
      hp: 300,
      maxHp: 300,
      observedTick: o.tick,
    },
    {
      ref: "enemy-b",
      name: "MTNK",
      type: 7,
      x: 71,
      y: 45,
      hp: 300,
      maxHp: 300,
      observedTick: o.tick,
    },
  ];
  c.decide(o);
  assert.equal(c.controlPlan!.combat.kind, "defend");
  o.tick += 90;
  o.enemies = o.enemies.slice(0, 1);
  c.decide(o);
  assert.equal(c.controlPlan!.combat.kind, "advance");
  assert.equal(c.controlPlan!.combat.units.length, 4);
});

test("a wiped assault releases surviving joiners back into the reserve", () => {
  const c = new Commander("bastion"),
    o = observation();
  o.own = o.own.filter((u) => u.name !== "MTNK");
  o.own.push(
    ...Array.from({ length: 6 }, (_, i) => tank(`wave-${i}`, 68 + (i % 3), 42)),
  );
  c.decide(o);
  assert.equal(c.controlPlan!.combat.kind, "advance");
  o.own.push(
    ...Array.from({ length: 4 }, (_, i) => tank(`reinforcement-${i}`, 68, 43)),
  );
  o.tick += 3;
  c.decide(o);
  assert(
    c.controlPlan!.additionalCombat!.some((m) => m.id === "reinforcements"),
  );
  o.own = o.own.filter((u) => !u.ref.startsWith("wave-"));
  o.tick += 3;
  c.decide(o);
  assert.equal(c.controlPlan!.combat.kind, "defend");
  assert.equal(c.controlPlan!.combat.units.length, 4);
  assert(
    !c.controlPlan!.additionalCombat!.some((m) => m.id === "reinforcements"),
  );
});

test("the offensive cohort funds its first force before expanding the economy", () => {
  const c = new Commander("cohort-local"),
    o = observation();
  c.decide(o);
  assert.equal(c.controlPlan!.production.vehicles.harvesters, 2);
  assert(
    c
      .controlPlan!.production.structures.filter((g) => g.product === "GAREFN")
      .every((g) => g.count === 1),
  );
  o.own = o.own.filter((u) => u.name !== "MTNK");
  o.own.push(
    ...Array.from({ length: 6 }, (_, i) => tank(`wave-${i}`, 68 + (i % 3), 42)),
  );
  o.tick += 3;
  c.decide(o);
  assert.equal(c.controlPlan!.combat.kind, "advance");
  assert.equal(c.controlPlan!.production.vehicles.harvesters, 4);
});

test("extra combat tasks keep separate ownership and receive only their own feedback", () => {
  const c = new Commander("bastion"),
    o = observation();
  o.own.push({ ...tank("gi", 67, 41), name: "E1", type: 3 });
  c.decide(o);
  const garrison = c.controlPlan!.additionalCombat![0];
  const effect: ExecutionEvidence = {
    origin: {
      id: garrison.id,
      revision: garrison.revision,
      controller: "tactics",
    },
    intentId: "gi-deployment",
    basedOnTick: o.tick,
    observedTick: o.tick + 3,
    effect: "deployment_state_changed",
    unresolved: false,
  };
  c.acceptEffect(effect);
  o.tick += 3;
  c.decide(o);
  assert.deepEqual(c.controlReport!.additionalCombat![0].executionEvidence, [
    effect,
  ]);
  assert.deepEqual(c.controlReport!.combat.executionEvidence, []);
  const invalid = {
    ...c.controlPlan!,
    additionalCombat: [{ ...garrison, units: ["a"] }],
  };
  assert.throws(
    () => new ControlCoordinator().compile(o, invalid, []),
    /assignment/,
  );
});

test("a defensive handoff cancels an offensive order even when the old hold key is cached", () => {
  const tactics = new PositionTactics(),
    o = observation();
  o.own = [tank("a", 18, 20)];
  const defense: CombatMission = {
    id: "main",
    revision: 1,
    kind: "defend",
    units: ["a"],
    destination: { x: 20, y: 20 },
    objective: "hold",
    engagement: { allowCrush: false },
  };
  assert.equal(tactics.control(o, defense, []).intents[0].kind, "stop");
  o.tick += 3;
  assert.equal(
    tactics.control(
      o,
      {
        ...defense,
        revision: 2,
        kind: "advance",
        destination: { x: 40, y: 40 },
      },
      [],
    ).intents[0].kind,
    "attackMove",
  );
  o.tick += 3;
  assert.equal(
    tactics.control(o, { ...defense, revision: 3 }, []).intents[0].kind,
    "stop",
  );
});

test("GI defense packs up out of range, approaches, deploys and actually attacks", () => {
  const tactics = new PositionTactics(),
    o = observation();
  const gi = {
    ...tank("gi", 36, 78),
    name: "E1",
    type: 3,
    crusher: false,
    deployed: true,
    weaponRange: 4,
    deployedWeaponRange: 5,
  };
  o.own = [gi];
  o.enemies = [
    {
      ref: "enemy",
      name: "E1",
      type: 3,
      x: 37,
      y: 68,
      hp: 125,
      maxHp: 125,
      observedTick: o.tick,
    },
  ];
  const mission: CombatMission = {
    id: "garrison",
    revision: 1,
    kind: "defend",
    units: ["gi"],
    destination: { x: 37, y: 70 },
    objective: "protect-base",
    engagement: { allowCrush: false },
  };
  assert.equal(tactics.control(o, mission, []).intents[0].kind, "deploy");
  o.tick += 60;
  gi.deployed = false;
  assert.equal(tactics.control(o, mission, []).intents[0].kind, "attack");
  o.tick += 60;
  gi.x = 37;
  gi.y = 72;
  assert.equal(tactics.control(o, mission, []).intents[0].kind, "deploy");
  o.tick += 60;
  gi.deployed = true;
  assert.equal(tactics.control(o, mission, []).intents[0].kind, "attack");
});

test("a damaged factory redirects the assault and infantry without conflicting unit ownership", () => {
  const c = new Commander("bastion"),
    o = observation();
  o.own = o.own.filter((u) => u.name !== "MTNK");
  o.own.push(
    ...Array.from({ length: 6 }, (_, i) =>
      tank(`force-${i}`, 68 + (i % 3), 42),
    ),
  );
  o.own.push({
    ...tank("gi", 67, 43),
    name: "E1",
    type: 3,
    deployed: true,
    crusher: false,
  });
  c.decide(o);
  assert.equal(c.controlPlan!.combat.kind, "advance");
  o.tick += 90;
  o.own.find((u) => u.ref === "factory")!.hp -= 50;
  o.enemies = [
    {
      ref: "enemy",
      name: "E1",
      type: 3,
      x: 80,
      y: 38,
      hp: 125,
      maxHp: 125,
      observedTick: o.tick,
    },
  ];
  c.decide(o);
  const plan = c.controlPlan!;
  assert.equal(plan.combat.objective, "protect-base");
  assert.equal(plan.combat.kind, "defend");
  assert.equal(plan.combat.units.length, 6);
  assert.deepEqual(
    plan.additionalCombat![0].destination,
    plan.combat.destination,
  );
  const refs = [plan.combat, ...plan.additionalCombat!].flatMap((m) => m.units);
  assert.equal(new Set(refs).size, refs.length);
  o.tick += 450;
  o.enemies = [];
  c.decide(o);
  assert.ok(
    c.controlPlan!.additionalCombat![0].destination!.x > o.home.x,
    "after contact is lost, the garrison still faces the observed approach",
  );
});

test("defending infantry do not chase a distant visitor away from the protected buildings", () => {
  const tactics = new PositionTactics(),
    o = observation();
  o.home = { x: 0, y: 0 };
  o.own = [
    { ...tank("gi", 0, 5), name: "E1", type: 3, crusher: false },
    building("yard", "GACNST", 0, 0),
  ];
  const mission: CombatMission = {
    id: "guard",
    revision: 1,
    kind: "defend",
    units: ["gi"],
    destination: { x: 0, y: 5 },
    protectedAssets: ["yard"],
    objective: "guard-base",
    engagement: { allowCrush: false },
  };
  o.enemies = [
    {
      ref: "enemy",
      name: "E1",
      type: 3,
      x: 0,
      y: 13,
      hp: 125,
      maxHp: 125,
      weaponRange: 5,
      observedTick: o.tick,
    },
  ];
  assert.equal(tactics.control(o, mission, []).intents[0].kind, "stop");
  o.tick += 60;
  o.enemies[0].y = 7;
  assert.equal(tactics.control(o, mission, []).intents[0].kind, "deploy");
});

test("a moving guard post preserves a nearby engagement, but an urgent reassignment can interrupt it", () => {
  const tactics = new PositionTactics(),
    o = observation();
  o.own = [
    {
      ...tank("gi", 0, 0),
      name: "E1",
      type: 3,
      deployed: true,
      crusher: false,
    },
  ];
  o.enemies = [
    {
      ref: "upper",
      name: "E1",
      type: 3,
      x: 4,
      y: 0,
      hp: 50,
      maxHp: 125,
      observedTick: o.tick,
    },
    {
      ref: "lower",
      name: "E1",
      type: 3,
      x: 0,
      y: 19,
      hp: 125,
      maxHp: 125,
      observedTick: o.tick,
    },
  ];
  const mission: CombatMission = {
    id: "guard",
    revision: 1,
    kind: "defend",
    units: ["gi"],
    destination: { x: 0, y: 18 },
    objective: "guard-base",
    threats: ["lower"],
    engagement: { allowCrush: false },
  };
  assert.deepEqual(tactics.control(o, mission, []).intents, [
    { kind: "attack", refs: ["gi"], target: "upper", task: "guard" },
  ]);
  // A closer newcomer does not continually reset the existing native attack order.
  o.tick += 60;
  o.enemies.push({ ...o.enemies[0], ref: "newcomer", x: 3 });
  assert.equal(tactics.control(o, mission, []).intents.length, 0);
  o.tick += 60;
  assert.equal(
    tactics.control(
      o,
      {
        ...mission,
        revision: 2,
        engagement: { allowCrush: false, interrupt: true },
      },
      [],
    ).intents[0].kind,
    "deploy",
  );
  o.tick += 60;
  o.own[0].deployed = false;
  o.own[0].y = 17;
  assert.equal(tactics.control(o, mission, []).intents[0].kind, "deploy");
});

test("two approaches keep engaged defenders, send free troops, and can reinforce a critical building", () => {
  const allocator = new DefenseAssignments();
  const upper = building("upper-base", "GAREFN", 23, 10);
  const lower = building("lower-base", "GAWEAP", 23, 30);
  const infantry = Array.from({ length: 6 }, (_, i) => ({
    ...tank(`gi-${i}`, 20, i < 4 ? 10 : 20),
    name: "E1",
    type: 3,
    hp: 125,
    maxHp: 125,
    deployed: i < 4,
  }));
  const incidents = [upper, lower].flatMap((asset) =>
    Array.from({ length: 3 }, (_, i) => ({
      enemy: {
        ref: `${asset.ref}-${i}`,
        name: "E1",
        type: 3,
        x: 24 + (i % 2),
        y: asset.y,
        hp: 125,
        maxHp: 125,
        observedTick: 0,
        weaponRange: 5,
      },
      asset,
      distance: 1,
    })),
  );
  const first = allocator.assign(0, infantry, incidents, new Map());
  const upperGroup = first.find((g) => g.protectedAssets.includes(upper.ref))!;
  const lowerGroup = first.find((g) => g.protectedAssets.includes(lower.ref))!;
  assert.equal(first.length, 2);
  assert.deepEqual(upperGroup.units, ["gi-0", "gi-1", "gi-2", "gi-3"]);
  assert.deepEqual(lowerGroup.units, ["gi-4", "gi-5"]);
  const again = allocator.assign(
    90,
    [...infantry].reverse(),
    [...incidents].reverse(),
    new Map(),
  );
  assert.deepEqual(
    again.find((g) => g.id === upperGroup.id)!.units,
    upperGroup.units,
  );
  lower.hp = 60;
  const emergency = allocator.assign(
    93,
    infantry,
    incidents,
    new Map([[lower.ref, 93]]),
  );
  const relief = emergency.find((g) => g.id === lowerGroup.id)!;
  assert.equal(relief.urgent, true);
  assert.equal(relief.units.length, 4);
  assert.equal(
    new Set(emergency.flatMap((g) => g.units)).size,
    infantry.length,
  );
  const cleared = allocator.assign(
    300,
    infantry,
    incidents.filter((i) => i.asset === lower),
    new Map(),
  );
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].units.length, 6);
});

test("a small guard concentrates on its current fight rather than dividing into single infantry", () => {
  const allocator = new DefenseAssignments();
  const infantry = [0, 1, 2].map((i) => ({
    ...tank(`gi-${i}`, 0, i),
    name: "E1",
    type: 3,
  }));
  const incidents = [0, 25].map((y) => ({
    enemy: {
      ref: `enemy-${y}`,
      name: "E1",
      type: 3,
      x: 3,
      y,
      hp: 125,
      maxHp: 125,
      observedTick: 0,
    },
    asset: building(`building-${y}`, "GAREFN", 0, y),
    distance: 1,
  }));
  const groups = allocator.assign(0, infantry, incidents, new Map());
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].threats, ["enemy-0"]);
  assert.equal(groups[0].units.length, 3);
  // A new wave on the other approach must not restart whole-group shuttling.
  const repeated = allocator.assign(
    3,
    infantry,
    [...incidents].reverse(),
    new Map(),
  );
  assert.equal(repeated[0].id, groups[0].id);
});

test("insufficient reserves do not become a solitary second squad", () => {
  const allocator = new DefenseAssignments();
  const infantry = Array.from({ length: 6 }, (_, i) => ({
    ...tank(`gi-${i}`, i < 5 ? 0 : 15, 0),
    name: "E1",
    type: 3,
  }));
  const incidents = [0, 25].flatMap((y) =>
    Array.from({ length: y === 0 ? 4 : 1 }, (_, i) => ({
      enemy: {
        ref: `enemy-${y}-${i}`,
        name: "E1",
        type: 3,
        x: 3,
        y,
        hp: 125,
        maxHp: 125,
        observedTick: 0,
      },
      asset: building(`base-${y}`, "GAREFN", 0, y),
      distance: 1,
    })),
  );
  const groups = allocator.assign(0, infantry, incidents, new Map());
  assert.equal(
    groups.find((g) => g.threats.includes("enemy-0-0"))!.units.length,
    6,
  );
  assert(!groups.some((g) => g.units.length === 1));
  // Six visible attackers on one approach plus a diversion exceed this guard's split budget.
  const stronger = [
    ...incidents,
    ...[4, 5].map((i) => ({
      ...incidents[0],
      enemy: { ...incidents[0].enemy, ref: `extra-${i}` },
    })),
  ];
  const focused = allocator.assign(3, infantry, stronger, new Map());
  assert.equal(focused.length, 1);
  assert.equal(focused[0].units.length, 6);
});

test("defensive armor can crush nearby infantry but first engages a closer tank", () => {
  const tactics = new PositionTactics(),
    o = observation();
  o.own = [tank("a", 20, 20)];
  o.enemies = [
    {
      ref: "infantry",
      name: "E1",
      type: 3,
      x: 25,
      y: 20,
      hp: 125,
      maxHp: 125,
      observedTick: o.tick,
    },
  ];
  const mission: CombatMission = {
    id: "defense",
    revision: 1,
    kind: "defend",
    units: ["a"],
    destination: { x: 20, y: 20 },
    objective: "protect-base",
    engagement: { allowCrush: true },
  };
  assert.equal(tactics.control(o, mission, []).intents[0].kind, "crush");
  o.tick += 60;
  o.enemies.push({
    ref: "tank",
    name: "MTNK",
    type: 7,
    x: 22,
    y: 20,
    hp: 300,
    maxHp: 300,
    observedTick: o.tick,
  });
  const response = tactics.control(o, mission, []).intents[0];
  assert.equal(response.kind, "attack");
  assert.equal("target" in response && response.target, "tank");
});

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

test("the coordinator enforces an explicit no-crushing mission even if a tactic ignores it", () => {
  const c = new ControlCoordinator(),
    o = observation();
  c.decide(o);
  const plan = {
    ...c.plan!,
    combat: { ...c.plan!.combat, engagement: { allowCrush: false } },
  };
  const result = c.components.tactics.control(o, plan.combat, []);
  assert.throws(
    () =>
      c.compile(o, plan, [
        {
          ...result,
          intents: [{ kind: "crush", refs: ["a"], target: "visible-infantry" }],
        },
      ]),
    /forbids explicit crushing/,
  );
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

test("old or unassigned command objects cannot cross the current execution boundary", () => {
  const c = new Commander("factory-exit"),
    o = observation();
  const first = c.decide(o);
  assert.doesNotThrow(() => c.assertCurrentIntent(first[0], o.tick));
  const later = { ...o, tick: o.tick + 3 };
  c.decide(later);
  assert.throws(
    () => c.assertCurrentIntent(first[0], later.tick),
    /current control decision/,
  );
  assert.throws(
    () =>
      c.assertCurrentIntent(
        { kind: "move", refs: ["a"], x: 20, y: 20 },
        later.tick,
      ),
    /current control decision/,
  );
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
