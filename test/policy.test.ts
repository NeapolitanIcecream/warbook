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
