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
