import { test } from "node:test";
import assert from "node:assert/strict";
import { observedEffect } from "../src/effects.js";
import type { Observation } from "../src/model.js";

const empty: Observation = {
  tick: 3,
  side: 0,
  credits: 0,
  power: { total: 0, drain: 0, isLowPower: false },
  home: { x: 0, y: 0 },
  starts: [],
  own: [],
  enemies: [],
  queues: [],
  products: [],
  buildSites: [],
};
test("a contact disappearing is not damage or a kill effect", () => {
  assert.equal(
    observedEffect(
      {
        id: "i",
        tick: 0,
        intent: { kind: "attack", refs: ["self"], target: "enemy" },
        units: [],
        targetHp: 100,
      },
      empty,
    ),
    undefined,
  );
});
test("a ready request without an observed building has no placement effect", () => {
  assert.equal(
    observedEffect(
      {
        id: "i",
        tick: 0,
        intent: { kind: "place", name: "GAPOWR", x: 1, y: 1 },
        units: [],
      },
      empty,
    ),
    undefined,
  );
});
