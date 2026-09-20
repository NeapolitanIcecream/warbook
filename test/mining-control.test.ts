import { test } from "node:test";
import assert from "node:assert/strict";
import { NativeOrders } from "../src/control/native-orders.js";
import { HarvesterTactics, MiningArea } from "../src/control/harvesters.js";
import type { Observation, Unit, Intent } from "../src/model.js";
import type { CombatMission } from "../src/control/contracts.js";

const miner = (ref = "miner", x = 25, y = 25): Unit => ({
  ref,
  name: "CMIN",
  type: 7,
  x,
  y,
  hp: 1000,
  maxHp: 1000,
  width: 1,
  height: 1,
  mobile: true,
  idle: false,
  harvester: true,
  cargo: 4,
  mcv: false,
  yard: false,
  refinery: false,
  combat: false,
});
const mission: CombatMission = {
  id: "mining",
  revision: 1,
  kind: "harvest",
  units: ["miner"],
  objective: "preserve-income",
  engagement: { allowCrush: false },
};
const observation = (): Observation => ({
  tick: 6000,
  home: { x: 10, y: 10 },
  side: 0,
  credits: 1000,
  power: { total: 100, drain: 0, isLowPower: false },
  starts: [],
  own: [
    miner(),
    {
      ...miner("refinery", 10, 10),
      type: 2,
      width: 3,
      height: 3,
      refinery: true,
      harvester: false,
      buildStatus: 1,
    },
  ],
  enemies: [],
  products: [],
  queues: [],
  buildSites: [],
  oreFields: [
    { x: 25, y: 25, amount: 300 },
    { x: 5, y: 15, amount: 200 },
  ],
});

test("active native travel and attacks survive timers and internal task labels", () => {
  const memory = new NativeOrders(),
    u = miner();
  const move: Intent = {
    kind: "attackMove",
    refs: [u.ref],
    x: 70,
    y: 60,
    task: "a",
  };
  assert(memory.allow(u, move, 0));
  assert(!memory.allow(u, { ...move, task: "b" }, 900));
  assert(
    memory.allow({ ...u, idle: true }, move, 901),
    "observable idle task can be retried",
  );
  const attack: Intent = { kind: "attack", refs: [u.ref], target: "enemy" };
  assert(memory.allow(u, attack, 1000));
  assert(
    !memory.allow({ ...u, idle: true, attackState: 3 }, attack, 1900),
    "firing is not an idle failure",
  );
});

test("deploy toggles are separate actions, and completed movement does not restart", () => {
  const memory = new NativeOrders(),
    u = miner();
  const deploy: Intent = { kind: "deploy", refs: [u.ref] };
  assert(memory.allow({ ...u, deployed: false }, deploy, 0));
  assert(memory.allow({ ...u, deployed: true }, deploy, 3));
  const move: Intent = { kind: "move", refs: [u.ref], x: u.x, y: u.y };
  assert(memory.allow(u, move, 40));
  assert(!memory.allow({ ...u, idle: true }, move, 900));
});

test("a hit miner docks once, preserves its native return, then resumes at safe ore", () => {
  const control = new HarvesterTactics(),
    o = observation();
  assert.equal(control.control(o, mission, []).intents.length, 0);
  o.tick += 3;
  o.own[0].hp -= 30;
  assert.deepEqual(control.control(o, mission, []).intents, [
    { kind: "dock", refs: ["miner"], target: "refinery", task: "mining" },
  ]);
  o.tick += 210;
  assert.equal(control.control(o, mission, []).intents.length, 0);
  Object.assign(o.own[0], { x: 12, y: 11, cargo: 0 });
  assert.deepEqual(control.control(o, mission, []).intents, [
    { kind: "gather", refs: ["miner"], x: 5, y: 15, task: "mining" },
  ]);
});

test("return selects a safe owned refinery and changes target if that refinery is lost", () => {
  const control = new HarvesterTactics(),
    o = observation();
  o.own.push({ ...o.own[1], ref: "safe", x: 1, y: 1 });
  o.enemies = [
    {
      ref: "enemy",
      name: "MTNK",
      type: 7,
      x: 12,
      y: 11,
      hp: 300,
      maxHp: 300,
      observedTick: o.tick,
      weaponRange: 5,
    },
  ];
  control.control(o, mission, []);
  o.tick += 3;
  o.own[0].hp -= 20;
  const first = control.control(o, mission, []).intents[0];
  assert(first.kind === "dock" && first.target === "safe");
  o.tick += 3;
  o.own = o.own.filter((u) => u.ref !== "safe");
  const next = control.control(o, mission, []).intents[0];
  assert(next.kind === "dock" && next.target === "refinery");
});

test("the mining screen follows cargo gains at a new patch, not unloading trips home", () => {
  const area = new MiningArea(),
    o = observation();
  assert.equal(area.observe(o), undefined);
  o.tick += 3;
  o.own[0].cargo = 5;
  assert.deepEqual(area.observe(o), { x: 25, y: 25 });
  o.tick += 150;
  Object.assign(o.own[0], { x: 12, y: 11, cargo: 0 });
  assert.deepEqual(area.observe(o), { x: 25, y: 25 });
  o.tick += 150;
  Object.assign(o.own[0], { x: 60, y: 50, cargo: 1 });
  assert.deepEqual(
    area.observe(o),
    { x: 60, y: 50 },
    "also works beyond the old home-distance limit",
  );
});

test("a safe destination behind visible guns is not a safe return to work", () => {
  const control = new HarvesterTactics(),
    o = observation();
  control.control(o, mission, []);
  o.tick += 3;
  o.own[0].hp -= 30;
  control.control(o, mission, []);
  o.tick += 210;
  Object.assign(o.own[0], { x: 12, y: 11, cargo: 0 });
  o.oreFields = [{ x: 40, y: 11, amount: 100 }];
  o.enemies = [
    {
      ref: "ambush",
      name: "MTNK",
      type: 7,
      x: 25,
      y: 11,
      hp: 300,
      maxHp: 300,
      observedTick: o.tick,
      weaponRange: 5,
    },
  ];
  assert.equal(control.control(o, mission, []).intents[0].kind, "stop");
  o.tick += 30;
  o.enemies = [];
  assert.equal(control.control(o, mission, []).intents[0].kind, "gather");
});
