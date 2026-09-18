import { test } from "node:test";
import assert from "node:assert/strict";
import { Operations } from "../src/control/operations.js";
import type { Contact, Observation, Unit } from "../src/model.js";

const contact = (ref: string, name: string, x: number, type = 7): Contact => ({
  ref,
  name,
  x,
  y: 0,
  type,
  hp: type === 2 ? 1000 : 300,
  maxHp: type === 2 ? 1000 : 300,
  observedTick: 6000,
  weaponRange: type === 2 ? 0 : 5,
});
const force = (count = 4): Unit[] =>
  Array.from({ length: count }, (_, i) => ({
    ...contact(`own-${i}`, "MTNK", i),
    width: 1,
    height: 1,
    mobile: true,
    idle: true,
    harvester: false,
    mcv: false,
    yard: false,
    refinery: false,
    combat: true,
  }));
const observation = (enemies: Contact[]): Observation => ({
  tick: 6000,
  side: 0,
  credits: 1000,
  power: { total: 200, drain: 100, isLowPower: false },
  home: { x: 0, y: 0 },
  starts: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ],
  own: force(),
  enemies,
  products: [],
  queues: [],
  buildSites: [],
});

test("a long attack on a partially scouted base reserves risk for unknown production", () => {
  const o = observation([
    contact("refinery", "GAREFN", 60, 2),
    contact("guard", "MTNK", 60),
  ]);
  const planner = new Operations();
  planner.observe(o, []);
  assert.equal(planner.consider(o, o.own), undefined);
  assert.equal(planner.decision.assumedProduction, true);
  assert(Number(planner.decision.productionArrivals) > 0);
});

test("a previously observed factory continues to count when it leaves vision", () => {
  const o = observation([
    contact("factory", "GAWEAP", 90, 2),
    contact("refinery", "GAREFN", 60, 2),
  ]);
  const planner = new Operations();
  planner.observe(o, []);
  o.tick += 3;
  o.enemies = o.enemies.filter((e) => e.name !== "GAWEAP");
  planner.observe(o, []);
  const operation = planner.consider(o, o.own);
  assert(operation);
  assert.equal(operation.assumedProduction, false);
  assert(operation.productionArrivals > 0);
});

test("a lead tank crossing the home boundary does not hide its supporting group", () => {
  const lead = contact("lead", "MTNK", 23);
  const o = observation([
    lead,
    ...Array.from({ length: 5 }, (_, i) =>
      contact(`support-${i}`, "MTNK", 26 + i),
    ),
  ]);
  const planner = new Operations();
  planner.observe(o, [lead]);
  assert.equal(planner.consider(o, o.own), undefined);
  assert.equal(planner.decision.operationReason, "local-support-risk");
  assert.equal(planner.decision.defenders, 6);

  const lone = new Operations();
  o.enemies = [lead];
  lone.observe(o, [lead]);
  assert.equal(
    lone.consider(o, o.own)?.reason,
    "local-counterattack",
    "a genuinely isolated remaining attacker still permits a counterattack",
  );
});

test("newly revealed defenders invalidate an ongoing attack before the force is lost", () => {
  const target = contact("target", "GAREFN", 30, 2);
  const o = observation([target, contact("factory", "GAWEAP", 100, 2)]);
  const planner = new Operations();
  planner.observe(o, []);
  planner.active = planner.consider(o, o.own);
  assert(planner.active);
  o.tick += 150;
  o.own = o.own.map((u) => ({ ...u, x: u.x + 24 }));
  o.enemies.push(
    ...Array.from({ length: 5 }, (_, i) =>
      contact(`guard-${i}`, "MTNK", 31 + i),
    ),
  );
  planner.observe(o, []);
  assert.equal(planner.target(o, o.own), undefined);

  target.hp = 20;
  planner.active = {
    point: target,
    ref: target.ref,
    reason: "attack-opportunity",
    defenders: 0,
    productionArrivals: 0,
    travelSeconds: 0,
  };
  planner.observe(o, []);
  assert.equal(
    planner.target(o, o.own)?.ref,
    target.ref,
    "finish a nearly destroyed objective already in range rather than discarding the result",
  );
});

test("a supported three-tank opportunity can finish a weak base without waiting for a fourth", () => {
  const o = observation([
    contact("barracks", "GAPILE", 20, 2),
    contact("factory", "GAWEAP", 100, 2),
  ]);
  o.enemies[0].hp = 400;
  o.own = force(3).map((u) => ({ ...u, hp: 240 }));
  const planner = new Operations();
  planner.observe(o, []);
  assert.equal(planner.consider(o, o.own)?.ref, "barracks");
  o.enemies.push(
    ...Array.from({ length: 4 }, (_, i) =>
      contact(`guard-${i}`, "MTNK", 21 + i),
    ),
  );
  planner.observe(o, []);
  assert.equal(
    planner.consider(o, o.own),
    undefined,
    "the force still waits when its actual opposition is stronger",
  );
});

test("a field army can intercept an attack without reaching its own distant base", () => {
  const o = observation([
    contact("refinery", "GAREFN", 24, 2),
    contact("factory", "GAWEAP", 32, 2),
    ...Array.from({ length: 3 }, (_, i) =>
      contact(`guard-${i}`, "MTNK", 33 + i),
    ),
    ...Array.from({ length: 10 }, (_, i) => ({
      ...contact(`field-${i}`, "MTNK", 101 + i),
      y: 44,
    })),
  ]);
  o.enemies = o.enemies.map((e) =>
    e.ref.startsWith("field-") ? e : { ...e, y: 89 },
  );
  o.home = { x: 141, y: 81 };
  o.own = force(12).map((u, i) => ({
    ...u,
    x: 132 + (i % 3),
    y: 79 + Math.floor(i / 3),
    position: {
      x: 132 + (i % 3) + 0.05,
      y: 79 + Math.floor(i / 3) + 0.5,
      z: 0,
    },
  }));
  const planner = new Operations();
  planner.observe(o, []);
  o.tick += 15;
  o.own = o.own.map((u) => ({
    ...u,
    x: u.x + 1,
    position: { ...u.position!, x: u.position!.x + 1.45 },
  }));
  planner.observe(o, []);
  assert.equal(planner.consider(o, o.own), undefined);
  assert(
    Number(planner.decision.defenders) >= 13,
    "the field army is not omitted just because its own base is far away",
  );
});

test("cleared observed factories are not replaced with a phantom production source", () => {
  const o = observation([
    contact("factory", "GAWEAP", 50, 2),
    contact("power", "GAPOWR", 55, 2),
  ]);
  o.own = force(2).map((u) => ({ ...u, x: u.x + 50 }));
  const planner = new Operations();
  planner.observe(o, []);
  o.enemies = o.enemies.filter((e) => e.name !== "GAWEAP");
  o.tick += 3;
  planner.observe(o, []);
  const operation = planner.consider(o, o.own);
  assert(operation);
  assert.equal(operation.productionArrivals, 0);
  assert.equal(operation.assumedProduction, false);
});
