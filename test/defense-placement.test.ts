import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defenseSite,
  defenseThreats,
  incomingFirePoints,
} from "../src/defense-placement.js";
import { LocalGroundMap } from "../src/local-ground-map.js";
import type { MapApi } from "@chronodivide/game-api";
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

test("a fort shares the infantry firing line and still prioritizes an observed attack", () => {
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
  assert.deepEqual(pick?.point, sites[1]);
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
  const imminent = defenseSite(
    { x: 10, y: 10 },
    own,
    [],
    ground,
    sites,
    { width: 1, height: 1 },
    5.5,
    [
      { x: 25, y: 0 },
      { x: 24, y: 0 },
      { x: 24, y: 1 },
    ],
  );
  assert.deepEqual(
    imminent?.point,
    sites[1],
    "an observed incoming force outweighs quiet perimeter coverage",
  );
});

test("a ready fort waits for a visible approach and uses a known path's contact point", () => {
  const own = [asset("power", 0)];
  const enemy = {
    ref: "incoming",
    name: "E1",
    type: 3,
    x: -14,
    y: 0,
    hp: 125,
    maxHp: 125,
    weaponRange: 5,
    observedTick: 0,
  };
  const map = {
    getTile: (rx: number, ry: number) => ({ rx, ry, z: 0 }),
    isVisibleTile: () => true,
    hasBridgeOnTile: () => false,
    isPassableTile: () => true,
    findPath: () => {
      throw new Error("do not query live engine navigation");
    },
  } as unknown as MapApi;
  const nav = new LocalGroundMap(map, "self", { x: 0, y: 0 }, 5, 22, true);
  assert.equal(defenseThreats(own, []).length, 0);
  assert.equal(defenseThreats(own, [{ ...enemy, x: -30 }]).length, 0);
  const [point] = incomingFirePoints(nav, own, [enemy]);
  assert(point.x >= -5 && point.x < 0);
  assert(Math.abs(point.y) <= 5);
});
