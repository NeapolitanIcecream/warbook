import { test } from "node:test";
import assert from "node:assert/strict";
import type { MapApi, PathNode } from "@chronodivide/game-api";
import { defenseRoute } from "../src/defense-route.js";

function mapFixture(hiddenDetour = false) {
  let calls = 0;
  const map = {
    getTile: (rx: number, ry: number) =>
      Math.abs(rx) <= 22 && Math.abs(ry) <= 22 ? { rx, ry } : undefined,
    isVisibleTile: (tile: { rx: number }) => tile.rx <= 14,
    hasBridgeOnTile: () => false,
    isPassableTile: (tile: { rx: number }) => {
      assert.ok(
        tile.rx <= 14,
        "do not inspect passability outside explored tiles",
      );
      return true;
    },
    findPath: (
      _speed: number,
      _subCell: boolean,
      from: PathNode,
      to: PathNode,
      options: { bestEffort: boolean; excludeNodes(n: PathNode): boolean },
    ) => {
      calls++;
      assert.equal(options.bestEffort, false);
      const hidden = { tile: { rx: 16, ry: 0 }, onBridge: false } as PathNode;
      assert.equal(options.excludeNodes(hidden), true);
      return [
        to,
        hiddenDetour ? hidden : { tile: { rx: 0, ry: 8 }, onBridge: false },
        from,
      ];
    },
  };
  return { map: map as unknown as MapApi, calls: () => calls };
}

test("defensive staging follows the explored engine path around a corner", () => {
  const f = mapFixture();
  assert.deepEqual(
    defenseRoute(f.map, "actor", { x: 0, y: 0 }, { x: 30, y: 0 }, 5),
    { x: 0, y: 8 },
  );
  assert.ok(f.calls() <= 6);
});

test("a returned route through an unexplored node cannot become a staging hint", () => {
  const f = mapFixture(true);
  assert.equal(
    defenseRoute(f.map, "actor", { x: 0, y: 0 }, { x: 30, y: 0 }, 5),
    undefined,
  );
  assert.ok(f.calls() <= 6);
});
