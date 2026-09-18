import { test } from "node:test";
import assert from "node:assert/strict";
import type { MapApi } from "@chronodivide/game-api";
import { baseRally, defenseRoute } from "../src/defense-route.js";
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

test("defensive staging is forward even when the route to it initially detours behind home", () => {
  const p = defenseRoute(
    mapFixture(),
    "actor",
    { x: 0, y: 0 },
    { x: 30, y: -30 },
    5,
  );
  assert(p);
  assert(
    p.x >= 6 && p.y < 0,
    "do not park guards at the rear turning point of the detour",
  );
});

test("an unexplored detour cannot become a staging hint", () => {
  const p = defenseRoute(
    mapFixture(true),
    "actor",
    { x: 0, y: 0 },
    { x: 30, y: -30 },
    5,
  );
  assert(p);
  assert(p.x < 4, "the post stays in the known reachable component");
});

test("the withdrawal rally stays near home and both posts avoid owned factory footprints", () => {
  const map = mapFixture(),
    home = { x: 0, y: 0 },
    nav = new LocalGroundMap(map, "actor", home, 5, 22);
  const occupied = [{ x: -1, y: -1, width: 3, height: 3 }];
  const rally = baseRally(nav, home, occupied),
    front = defenseRoute(
      map,
      "actor",
      home,
      { x: 30, y: -30 },
      5,
      nav,
      occupied,
    );
  assert(rally && front);
  const inside = (p: { x: number; y: number }) =>
    p.x >= -1 && p.x < 2 && p.y >= -1 && p.y < 2;
  assert(!inside(rally) && !inside(front));
  assert(Math.hypot(rally.x, rally.y) < Math.hypot(front.x, front.y));
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
