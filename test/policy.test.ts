import { test } from "node:test";
import assert from "node:assert/strict";
import { Commander } from "../src/policy.js";
import type { Observation, Unit } from "../src/model.js";
import { RaidTask } from "../src/raiding.js";

const tank = (ref = "tank"): Unit => ({
  ref,
  name: "MTNK",
  type: 7,
  x: 30,
  y: 30,
  hp: 400,
  maxHp: 400,
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
const observation = (own: Unit[] = [tank()]): Observation => ({
  tick: 0,
  side: 0,
  credits: 10000,
  power: { total: 200, drain: 0, isLowPower: false },
  home: { x: 25, y: 25 },
  starts: [
    { x: 25, y: 25 },
    { x: 70, y: 70 },
  ],
  own,
  enemies: [],
  products: [],
  queues: [],
  buildSites: [],
});

test("opening formation waits for the fourth tank to exit and join the force", () => {
  // Geometry recorded in assembly-recheck/mp06t2.map/counter/0-assembly:
  // three tanks waited outside; the fourth appeared inside GAWEAP at tick 5886.
  const factory = {
    ...tank("factory"),
    name: "GAWEAP",
    type: 2,
    x: 74,
    y: 37,
    width: 5,
    height: 3,
    mobile: false,
    combat: false,
  };
  const o = {
    ...observation([
      factory,
      { ...tank("a"), x: 76, y: 41 },
      { ...tank("b"), x: 76, y: 42 },
      { ...tank("c"), x: 78, y: 41 },
      { ...tank("d"), x: 76, y: 38, idle: false },
    ]),
    home: { x: 71, y: 37 },
    starts: [
      { x: 71, y: 37 },
      { x: 38, y: 73 },
    ],
    tick: 5886,
  };
  const policy = new Commander("formed");
  const factoryExit = new Commander("factory-exit");
  assert.ok(policy.decide(o).some((i) => i.task === "counter-rally"));
  assert.ok(factoryExit.decide(o).some((i) => i.task === "counter-rally"));
  assert.ok(
    !new Commander("assembly-only")
      .decide(o)
      .some((i) => i.task === "counter-rally"),
  );
  const joined = {
    ...o,
    tick: 6100,
    own: o.own.map((u) => (u.ref === "d" ? { ...u, x: 77, y: 42 } : u)),
  };
  assert.ok(
    policy
      .decide(joined)
      .some((i) => i.kind === "attackMove" && i.x === 38 && i.y === 73),
  );
  const afterLoss = {
    ...joined,
    tick: 6550,
    own: joined.own.filter((u) => u.ref !== "a"),
  };
  assert.ok(
    factoryExit
      .decide(afterLoss)
      .some((i) => i.kind === "attackMove" && i.x === 38 && i.y === 73),
    "a casualty while the fourth tank exits does not erase the already completed production stage",
  );
  assert.ok(
    !policy.decide(afterLoss).some((i) => i.task === "counter-rally"),
    "opening commitment does not reset after casualties",
  );
  const dispersed = {
    ...o,
    own: o.own.map((u) => (u.ref === "d" ? { ...u, x: 60, y: 60 } : u)),
  };
  assert.ok(
    new Commander("formed")
      .decide(dispersed)
      .some((i) => i.task === "counter-rally"),
  );
  assert.ok(
    !new Commander("factory-exit")
      .decide(dispersed)
      .some((i) => i.task === "counter-rally"),
    "four tanks outside the factory can continue an existing engagement without returning to rally",
  );
  assert.ok(
    !new Commander("formed")
      .decide({ ...dispersed, tick: 9000 })
      .some((i) => i.task === "counter-rally"),
    "the existing time cap still releases a force that cannot assemble",
  );
});

test("a vanished enemy becomes a remembered position, never a new object-target attack", () => {
  const policy = new Commander();
  const o = observation();
  o.enemies = [
    {
      ref: "contact",
      name: "HTNK",
      type: 7,
      x: 35,
      y: 35,
      hp: 300,
      maxHp: 300,
      observedTick: 0,
    },
  ];
  assert.ok(
    policy.decide(o).some((i) => i.kind === "attack" && i.target === "contact"),
  );
  const later = { ...o, tick: 450, enemies: [] };
  const intents = policy.decide(later);
  assert.ok(!intents.some((i) => i.kind === "attack"));
  assert.ok(
    intents.some((i) => i.kind === "attackMove" && i.x === 35 && i.y === 35),
  );
});
test("renaming entity references preserves the action choice", () => {
  const a = observation([tank("alpha")]);
  const b = observation([tank("arbitrary-9999")]);
  const normalize = (value: unknown) =>
    JSON.stringify(value)
      .replaceAll("alpha", "REF")
      .replaceAll("arbitrary-9999", "REF");
  assert.equal(
    normalize(new Commander().decide(a)),
    normalize(new Commander().decide(b)),
  );
});
test("revisiting an empty last contact location resumes scouting", () => {
  const policy = new Commander();
  const o = observation();
  o.enemies = [
    {
      ref: "contact",
      name: "HTNK",
      type: 7,
      x: 35,
      y: 35,
      hp: 300,
      maxHp: 300,
      observedTick: 0,
    },
  ];
  policy.decide(o);
  const intents = policy.decide({
    ...o,
    tick: 450,
    own: [{ ...tank(), x: 35, y: 35 }],
    enemies: [],
  });
  assert.ok(
    intents.some((i) => i.kind === "attackMove" && i.x === 70 && i.y === 70),
  );
});
test("preserves an active production queue and does not send harvesters into the army", () => {
  const o = observation([{ ...tank("miner"), name: "CMIN", harvester: true }]);
  o.products = [
    { name: "GAPOWR", cost: 800, type: 2, queue: 0 },
    { name: "CMIN", cost: 1400, type: 7, queue: 3 },
  ];
  o.queues = [
    { type: 0, size: 1, status: 1, items: [{ name: "GAPOWR", quantity: 1 }] },
    { type: 3, size: 1, status: 1, items: [{ name: "CMIN", quantity: 1 }] },
  ];
  assert.deepEqual(new Commander().decide(o), []);
});
test("deployed infantry can pack up after contact is lost", () => {
  const o = observation([
    { ...tank("gi"), name: "E1", type: 3, mobile: false, deployed: true },
  ]);
  assert.ok(
    new Commander("guarded")
      .decide(o)
      .some((i) => i.kind === "deploy" && i.refs.includes("gi")),
  );
});
test("losing the construction yard does not switch the production faction", () => {
  const o = observation([
    tank(),
    ...Array.from({ length: 4 }, (_, i) => ({
      ...tank("miner-" + i),
      name: "CMIN",
      harvester: true,
    })),
  ]);
  o.products = [{ name: "MTNK", cost: 700, type: 7, queue: 3 }];
  o.queues = [{ type: 3, status: 0, size: 0, items: [] }];
  assert.ok(
    new Commander()
      .decide(o)
      .some((i) => i.kind === "queue" && i.product.name === "MTNK"),
  );
});
test("after visiting the spawns, scouting continues and keeps a progressing destination", () => {
  const policy = new Commander("combined");
  const o = {
    ...observation([{ ...tank(), x: 70, y: 70 }]),
    scoutPoints: [
      { x: 100, y: 100 },
      { x: 120, y: 30 },
    ],
  };
  assert.ok(
    policy
      .decide(o)
      .some((i) => i.kind === "attackMove" && i.x === 100 && i.y === 100),
  );
  const later = { ...o, tick: 950, own: [{ ...tank(), x: 85, y: 85 }] };
  assert.ok(
    policy
      .decide(later)
      .some((i) => i.kind === "attackMove" && i.x === 100 && i.y === 100),
  );
});
test("a scout destination without progress is postponed instead of retried forever", () => {
  const policy = new Commander("combined");
  const o = {
    ...observation([{ ...tank(), x: 70, y: 70 }]),
    scoutPoints: [
      { x: 100, y: 100 },
      { x: 120, y: 30 },
    ],
  };
  policy.decide(o);
  assert.ok(
    policy
      .decide({ ...o, tick: 950 })
      .some((i) => i.kind === "attackMove" && i.x === 120 && i.y === 30),
  );
});
test("flying infantry are not crush targets and trigger anti-air production", () => {
  const o = observation([{ ...tank(), crusher: true }]);
  o.enemies = [
    {
      ref: "air",
      name: "JUMPJET",
      type: 3,
      x: 34,
      y: 34,
      hp: 125,
      maxHp: 125,
      observedTick: 0,
      airborne: true,
    },
  ];
  o.products = [{ name: "FV", cost: 600, type: 7, queue: 3 }];
  o.queues = [{ type: 3, status: 0, size: 0, items: [] }];
  const intents = new Commander("combined").decide(o);
  assert.ok(intents.some((i) => i.kind === "queue" && i.product.name === "FV"));
  assert.ok(!intents.some((i) => i.kind === "crush" || i.kind === "attack"));
});
test("anti-air vehicles attack visible flying infantry", () => {
  const o = observation([{ ...tank("ifv"), name: "FV", antiAir: true }]);
  o.enemies = [
    {
      ref: "air",
      name: "JUMPJET",
      type: 3,
      x: 34,
      y: 34,
      hp: 125,
      maxHp: 125,
      observedTick: 0,
      airborne: true,
    },
  ];
  assert.ok(
    new Commander("combined")
      .decide(o)
      .some((i) => i.kind === "attack" && i.target === "air"),
  );
});

test("raiders pursue a visible miner without stealing all tanks or duplicating army orders", () => {
  const o = observation(
    Array.from({ length: 4 }, (_, i) => ({ ...tank(`tank-${i}`), x: 30 + i })),
  );
  o.enemies = [
    {
      ref: "defender",
      name: "HTNK",
      type: 7,
      x: 35,
      y: 30,
      hp: 400,
      maxHp: 400,
      observedTick: 0,
    },
    {
      ref: "miner",
      name: "CMIN",
      type: 7,
      x: 40,
      y: 35,
      hp: 1000,
      maxHp: 1000,
      observedTick: 0,
    },
  ];
  const intents = new Commander("raid").decide(o);
  const raid = intents.find((i) => i.task === "raid-economy");
  assert(raid && raid.kind === "attack");
  assert.equal(raid.target, "miner");
  assert.equal(raid.refs.length, 2);
  const refs = intents.flatMap((i) => ("refs" in i ? i.refs : []));
  assert.equal(new Set(refs).size, refs.length);
  assert(intents.some((i) => i.kind === "attack" && i.target === "defender"));
});

test("raiders retain a known area after losing contact without attacking an invisible entity", () => {
  const o = observation(Array.from({ length: 4 }, (_, i) => tank(`tank-${i}`)));
  o.enemies = [
    {
      ref: "miner",
      name: "CMIN",
      type: 7,
      x: 60,
      y: 60,
      hp: 1000,
      maxHp: 1000,
      observedTick: 0,
    },
  ];
  const raid = new RaidTask();
  raid.plan(o, o.own);
  const search = raid.plan({ ...o, tick: 30, enemies: [] }, o.own);
  assert(search && search.intent.kind === "move");
  assert.equal(search.intent.x, 60);
  assert.equal(raid.plan({ ...o, tick: 480, enemies: [] }, o.own), undefined);
});

test("the first raider scouts a candidate spawn despite a nearer frontline enemy", () => {
  const o = observation();
  o.enemies = [
    {
      ref: "frontline",
      name: "HTNK",
      type: 7,
      x: 35,
      y: 35,
      hp: 400,
      maxHp: 400,
      observedTick: 0,
    },
  ];
  const orders = new Commander("raid").decide(o);
  assert(
    orders.some(
      (i) =>
        i.kind === "move" &&
        i.task === "raid-scout" &&
        i.x === 70 &&
        i.y === 70,
    ),
  );
  assert(!orders.some((i) => i.kind === "attack"));
});

test("a damaged raider disengages from guards and keeps its retreat commitment", () => {
  const o = observation([{ ...tank(), hp: 100 }]);
  o.enemies = [
    {
      ref: "guard",
      name: "HTNK",
      type: 7,
      x: 35,
      y: 35,
      hp: 300,
      maxHp: 300,
      observedTick: 0,
    },
  ];
  const raid = new RaidTask();
  const retreat = raid.plan(o, o.own, { x: 70, y: 70 });
  assert(
    retreat &&
      retreat.intent.kind === "move" &&
      retreat.intent.task === "raid-retreat",
  );
  assert.equal(retreat.intent.x, o.home.x);
  assert.equal(
    raid.plan({ ...o, tick: 60, enemies: [] }, o.own, { x: 70, y: 70 })?.intent
      .task,
    "raid-retreat",
  );
});

test("counterattack keeps early armor near base then commits its assembled force", () => {
  const counter = new Commander("counter");
  const o = observation();
  o.enemies = [
    {
      ref: "distant",
      name: "HTNK",
      type: 7,
      x: 40,
      y: 30,
      hp: 300,
      maxHp: 300,
      observedTick: 0,
    },
  ];
  const waiting = counter.decide(o);
  assert(
    waiting.some((i) => i.kind === "attackMove" && i.task === "counter-rally"),
  );
  assert(!waiting.some((i) => i.kind === "attack"));
  const assembled = {
    ...o,
    tick: 450,
    own: Array.from({ length: 4 }, (_, i) => tank(`tank-${i}`)),
  };
  assert(
    counter
      .decide(assembled)
      .some((i) => i.kind === "attack" && i.target === "distant"),
  );
  assert(
    !counter
      .decide({ ...o, tick: 900 })
      .some((i) => i.task === "counter-rally"),
  );
});

test("an isolated tank waits for support against visible superior armor and resumes when assembled", () => {
  const policy = new Commander("coordinated");
  const o = observation([
    { ...tank("front"), x: 70, y: 70 },
    { ...tank("support"), x: 50, y: 50 },
    { ...tank("rear"), x: 40, y: 40 },
  ]);
  o.enemies = Array.from({ length: 3 }, (_, i) => ({
    ref: `enemy-${i}`,
    name: "MTNK",
    type: 7,
    x: 74 + i,
    y: 70,
    hp: 300,
    maxHp: 300,
    observedTick: 0,
  }));
  const first = policy.decide(o);
  assert(
    first.some(
      (i) =>
        i.kind === "move" &&
        i.refs.includes("front") &&
        i.task === "regroup-armor" &&
        i.x === 50,
    ),
  );
  const arrived = {
    ...o,
    tick: 60,
    own: [
      o.own[0],
      { ...o.own[1], x: 68, y: 70 },
      { ...o.own[2], x: 69, y: 70 },
    ],
  };
  assert(
    policy
      .decide(arrived)
      .some((i) => i.kind === "attack" && i.refs.includes("front")),
  );
});

test("opening-factor toggles distinguish rally goals from explicit contact filtering", () => {
  const o = observation();
  o.enemies = [
    {
      ref: "outside-base",
      name: "MTNK",
      type: 7,
      x: 40,
      y: 30,
      hp: 300,
      maxHp: 300,
      observedTick: 0,
    },
  ];
  const base = new Commander("combined").decide(o);
  const assembly = new Commander("assembly-only").decide(o);
  const filtering = new Commander("contact-filter").decide(o);
  const both = new Commander("counter").decide(o);
  assert(base.some((i) => i.kind === "attack"));
  assert(
    assembly.some((i) => i.kind === "attack"),
    "rally alone can still be overridden by a nearby contact",
  );
  assert(
    filtering.some((i) => i.kind === "attackMove" && i.x === 40),
    "filtering explicit targets alone still permits an advance goal",
  );
  assert(
    both.some(
      (i) =>
        i.kind === "attackMove" && i.task === "counter-rally" && i.x === 29,
    ),
  );
});

test("opening attribution variants keep the same economic decisions", () => {
  const o = observation();
  o.products = [
    { name: "GAPOWR", cost: 800, type: 2, queue: 0 },
    { name: "CMIN", cost: 1400, type: 7, queue: 3 },
  ];
  o.queues = [
    { type: 0, size: 0, status: 0, items: [] },
    { type: 3, size: 0, status: 0, items: [] },
  ];
  const economic = (
    mode:
      | "combined"
      | "counter"
      | "assembly-only"
      | "contact-filter"
      | "formed"
      | "factory-exit",
  ) =>
    new Commander(mode)
      .decide(o)
      .filter((i) => i.kind === "queue" || i.kind === "place");
  for (const mode of [
    "counter",
    "assembly-only",
    "contact-filter",
    "formed",
    "factory-exit",
  ] as const)
    assert.deepEqual(economic(mode), economic("combined"));
});
