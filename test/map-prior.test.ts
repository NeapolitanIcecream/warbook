import { test } from "node:test";
import assert from "node:assert/strict";
import { MapPrior } from "../src/map-prior.js";
import type { GameApi } from "@chronodivide/game-api";
import type { MapApi } from "@chronodivide/game-api";

test("static routes use a ramp rather than drawing a line through a cliff", () => {
  const cells = [];
  for (let x = 0; x < 6; x++)
    for (let y = 0; y < 5; y++)
      if (x !== 3 || y === 4) cells.push({ x, y, z: 0, bridge: false });
  const prior = new MapPrior(cells);
  const path = prior.path({ x: 1, y: 0 }, { x: 5, y: 0 });
  assert(path.some((p) => p.x === 3 && p.y === 4));
  assert(!path.some((p) => p.x === 3 && p.y !== 4));
});

test("map initialization rejects midgame world queries before touching map data", () => {
  const game = {
    getCurrentTick: () => 3,
    get map() {
      throw new Error("read world");
    },
  } as unknown as GameApi;
  assert.throws(() => MapPrior.readPregame(game), /before simulation/);
});

test("a scout route skirts a visible weapon zone when a safe route exists", () => {
  const cells = [];
  for (let x = 0; x <= 12; x++)
    for (let y = 0; y <= 12; y++) cells.push({ x, y, z: 0, bridge: false });
  const prior = new MapPrior(cells);
  const path = prior.path({ x: 0, y: 6 }, { x: 12, y: 6 }, [
    { x: 6, y: 6, radius: 3 },
  ]);
  assert(path.length > 0);
  assert(path.every((p) => (p.x - 6) ** 2 + (p.y - 6) ** 2 > 9));
});

test("bridge waypoints retain the layer and only observed destruction removes the route", () => {
  const prior = new MapPrior([
    { x: 0, y: 0, z: 0, bridge: false },
    { x: 1, y: 0, z: 0, bridge: true },
    { x: 2, y: 0, z: 0, bridge: false },
  ]);
  const route = () => prior.path({ x: 0, y: 0 }, { x: 2, y: 0 });
  assert.deepEqual(route()[1], { x: 1, y: 0, onBridge: true });
  let visible = false;
  const map = {
    getTile: () => ({}),
    isVisibleTile: () => visible,
    hasBridgeOnTile: () => false,
  } as unknown as MapApi;
  prior.updateVisibleBridges(map, "self");
  assert.equal(route().length, 3, "unseen bridge state cannot change planning");
  visible = true;
  prior.updateVisibleBridges(map, "self");
  assert.equal(route().length, 0);
});
