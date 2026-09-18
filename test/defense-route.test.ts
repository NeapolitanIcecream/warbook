import { test } from "node:test";
import assert from "node:assert/strict";
import type { MapApi } from "@chronodivide/game-api";
import { defenseRoute } from "../src/defense-route.js";
import { LocalGroundMap } from "../src/local-ground-map.js";

function mapFixture(hiddenDetour = false) {
  return {
    getTile: (rx: number, ry: number) =>
      Math.abs(rx) <= 22 && Math.abs(ry) <= 22 ? { rx, ry, z: 0 } : undefined,
    isVisibleTile: (t: { rx: number; ry: number }) =>
      t.rx <= 14 && (!hiddenDetour || t.ry < 7),
    hasBridgeOnTile: () => false,
    isPassableTile: (t: { rx: number; ry: number }) => {
      assert(
        t.rx <= 14 && (!hiddenDetour || t.ry < 7),
        "unexplored passability is never read",
      );
      return !(t.rx === 4 && t.ry < 7);
    },
    findPath: () => {
      throw new Error("planning must not touch the live path cache");
    },
    getReachabilityMap: () => {
      throw new Error("planning must not touch the live path cache");
    },
  } as unknown as MapApi;
}

test("defensive staging follows an explored detour on its independent ground graph", () => {
  const p = defenseRoute(
    mapFixture(),
    "actor",
    { x: 0, y: 0 },
    { x: 30, y: 0 },
    5,
  );
  assert(p);
  assert(
    p.y >= 5 && p.x <= 4,
    "the post follows the detour rather than pointing into the wall",
  );
});

test("an unexplored detour cannot become a staging hint", () => {
  assert.equal(
    defenseRoute(mapFixture(true), "actor", { x: 0, y: 0 }, { x: 30, y: 0 }, 5),
    undefined,
  );
});

test("hypothetical refinery footprints block only the independent query, without changing the next path", () => {
  const nav = new LocalGroundMap(mapFixture(), "actor", { x: 0, y: 0 }, 5, 20);
  const from = { x: 0, y: 0 },
    to = { x: 3, y: 0 };
  const initial = nav.path(from, to);
  const blocked = (p: { x: number; y: number }) =>
    p.x === 1 && Math.abs(p.y) <= 1;
  const detour = nav.path(from, to, blocked);
  assert(detour.length > initial.length);
  assert(detour.every((p) => !blocked(p)));
  assert.deepEqual(nav.path(from, to), initial);
});
