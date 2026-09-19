import { test } from "node:test";
import assert from "node:assert/strict";
import { NeutralEconomy } from "../src/control/neutral-economy.js";
import type { Observation } from "../src/model.js";

test("capture demand is funded by a visible safe goal and drops when defended", () => {
  const planner = new NeutralEconomy();
  const o = { tick: 0, home: { x: 0, y: 0 }, own: [], enemies: [], techBuildings: [] } as unknown as Observation;
  assert.equal(planner.plan(o).demand, 0);
  o.techBuildings = [{ ref: "oil", name: "CAOILD", x: 10, y: 10 }];
  assert.equal(planner.plan(o).demand, 1);
  o.enemies = [{ ref: "guard", name: "E1", type: 3, x: 10, y: 12, hp: 125, maxHp: 125, observedTick: 0, weaponRange: 5 }];
  assert.equal(planner.plan(o).demand, 0);
});
