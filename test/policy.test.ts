import { test } from "node:test";
import assert from "node:assert/strict";
import { Commander } from "../src/policy.js";
import type { Observation, Unit } from "../src/model.js";

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
    { name: "NAPOWR", cost: 800, type: 2, queue: 0 },
    { name: "HARV", cost: 1400, type: 7, queue: 3 },
  ];
  o.queues = [
    { type: 0, size: 1, status: 1, items: [{ name: "NAPOWR", quantity: 1 }] },
    { type: 3, size: 1, status: 1, items: [{ name: "HARV", quantity: 1 }] },
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
