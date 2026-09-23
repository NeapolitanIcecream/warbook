import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tacticalWorld,
  focusLabels,
  type TacticalObservation,
} from "../src/tactical/world.js";

test("tactical choices preserve native orders and expose only visible targets", () => {
  const o: TacticalObservation = {
    tick: 0,
    center: { x: 20, y: 20 },
    goal: { x: 20, y: 20 },
    radius: 10,
    task: "advance",
    own: [
      {
        ref: "ours",
        x: 16,
        y: 20,
        hp: 300,
        maxHp: 300,
        range: 5,
        cooldown: 12,
      },
    ],
    enemies: [
      {
        ref: "seen",
        x: 23,
        y: 20,
        hp: 20,
        maxHp: 300,
        range: 5,
        cooldown: 999,
      },
    ],
  };
  const w = tacticalWorld(o);
  assert.equal(w.entities[1][6], 0);
  assert.equal(w.entities[1][7], 0);
  assert.equal(w.actions[0][focusLabels(o, w)[0]].kind, "attack");
  assert(w.actions[0].some((a) => a.kind === "move"));
  assert(w.actions[0].some((a) => a.kind === "attackMove"));
  assert(
    w.actions[0].every(
      (a) =>
        !("point" in a) || (a.point.x - 20) ** 2 + (a.point.y - 20) ** 2 <= 100,
    ),
  );
  const empty = tacticalWorld({ ...o, enemies: [] });
  assert(empty.actions[0].every((a) => a.kind !== "attack"));
});
