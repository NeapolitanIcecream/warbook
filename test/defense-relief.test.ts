import { test } from "node:test";
import assert from "node:assert/strict";
import { DefenseRelief } from "../src/control/defense-relief.js";
import type { Observation, Unit, Contact } from "../src/model.js";

const tank = (ref: string, x: number): Unit => ({
  ref,
  name: "MTNK",
  type: 7,
  x,
  y: 0,
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
test("relief prefers a nearby reserve, retains its task, and releases it after contact clears", () => {
  const units = [
    tank("reserve", 2),
    ...Array.from({ length: 6 }, (_, i) => tank(`attacker-${i}`, 35 + i)),
  ];
  const o = {
    enemies: [],
    tick: 6000,
    home: { x: 0, y: 0 },
    own: units,
  } as unknown as Observation;
  const assault = new Set(units.slice(1).map((u) => u.ref));
  const raider: Contact = {
    ref: "raider",
    name: "E1",
    type: 3,
    x: 4,
    y: 0,
    hp: 125,
    maxHp: 125,
    weaponRange: 5,
    observedTick: o.tick,
  };
  const relief = new DefenseRelief();
  const choose = (threats: Contact[], requested = false) =>
    relief.assign(o, units, [], threats, { x: 3, y: 0 }, assault, requested);
  assert.deepEqual(
    choose([raider], true).map((u) => u.ref),
    ["reserve"],
  );
  o.tick += 3;
  assert.deepEqual(
    choose([raider]).map((u) => u.ref),
    ["reserve"],
  );
  o.tick += 3;
  assert.equal(choose([]).length, 1);
  o.tick += 150;
  assert.equal(choose([]).length, 0);
  const armor = Array.from({ length: 6 }, (_, i) => ({
    ...raider,
    ref: `enemy-${i}`,
    type: 7,
    name: "MTNK",
    hp: 300,
    maxHp: 300,
  }));
  assert.equal(
    choose(armor, true).length,
    7,
    "a serious attack can still require the entire available force",
  );
});
