import { test } from "node:test";
import assert from "node:assert/strict";
import { MapPrior } from "../src/map-prior.js";
import type { GameApi } from "@chronodivide/game-api";

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
