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
    isPassableTile: () => true,
  } as unknown as MapApi;
  prior.refreshVisible(map, "self");
  assert.equal(route().length, 3, "unseen bridge state cannot change planning");
  visible = true;
  prior.refreshVisible(map, "self");
  assert.equal(route().length, 0);
});

test("flank planning selects a separate real passage around a central barrier", () => {
  const cells = [];
  for (let x = 0; x <= 40; x++)
    for (let y = 0; y <= 30; y++)
      if (x !== 20 || y <= 3 || y >= 27)
        cells.push({ x, y, z: 0, bridge: false });
  const prior = new MapPrior(cells),
    from = { x: 3, y: 15 },
    to = { x: 37, y: 15 };
  const primary = prior.path(from, to),
    flank = prior.flank(from, to);
  assert(flank);
  assert(
    primary.every((p) => (p.x - flank.x) ** 2 + (p.y - flank.y) ** 2 >= 64),
  );
  assert(prior.path(from, flank).length > 0);
  assert(prior.path(flank, to).length > 0);
});

test("passable decorative islands are distinct from the army's reachable region", () => {
  const prior = new MapPrior([
    { x: 0, y: 0, z: 0, bridge: false },
    { x: 1, y: 0, z: 0, bridge: false },
    { x: 10, y: 0, z: 0, bridge: false },
  ]);
  assert.equal(prior.region({ x: 0, y: 0 }), prior.region({ x: 1, y: 0 }));
  assert.notEqual(prior.region({ x: 0, y: 0 }), prior.region({ x: 10, y: 0 }));
});
