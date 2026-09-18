import { test } from "node:test";
import assert from "node:assert/strict";
import { defenseSite } from "../src/defense-placement.js";
import type { Unit } from "../src/model.js";

const asset = (ref: string, x: number): Unit => ({
  ref,
  name: "GAPOWR",
  x,
  y: 0,
  width: 2,
  height: 2,
  type: 2,
  hp: 750,
  maxHp: 750,
  mobile: false,
  idle: false,
  harvester: false,
  mcv: false,
  yard: false,
  refinery: false,
  combat: false,
});

test("a fort covers the exposed approach left outside the infantry's fire", () => {
  const own = [
    asset("west", 0),
    asset("east", 20),
    ...Array.from({ length: 6 }, (_, i) => ({
      ...asset(`gi-${i}`, 22),
      name: "E1",
      type: 3,
      y: -1,
      width: 1,
      height: 1,
      combat: true,
      mobile: true,
      deployedWeaponRange: 5,
    })),
  ];
  const ground = [
    { x: -3, y: 0 },
    { x: 0, y: -3 },
    { x: 25, y: 0 },
    { x: 20, y: -3 },
  ];
  const sites = [
    { x: -2, y: -1 },
    { x: 22, y: -1 },
  ];
  const pick = defenseSite(
    { x: 10, y: 10 },
    own,
    [],
    ground,
    sites,
    { width: 1, height: 1 },
    5.5,
  );
  assert.deepEqual(pick?.point, sites[0]);
  assert(pick!.coverage > 0);
  const constrained = defenseSite(
    { x: 10, y: 10 },
    own,
    [],
    ground,
    [sites[1]],
    { width: 1, height: 1 },
    5.5,
  );
  assert.deepEqual(
    constrained?.point,
    sites[1],
    "placement cannot invent an unvalidated site",
  );
});
