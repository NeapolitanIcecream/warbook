import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiEventType } from "@chronodivide/game-api";
import { OwnLifecycle } from "../src/own-lifecycle.js";

test("own lifecycle ignores unknown/enemy destruction and all attacker identity", () => {
  const tracker = new OwnLifecycle();
  tracker.seenOwn(1, "own");
  tracker.onEvent(
    {
      type: ApiEventType.ObjectDestroy,
      target: 2,
      attackerInfo: { playerName: "hidden", objId: 999, weaponName: "hidden" },
    },
    "us",
  );
  assert.deepEqual(tracker.takeDepartures(), []);
  tracker.onEvent(
    { type: ApiEventType.ObjectDestroy, target: 1, attackerInfo: undefined },
    "us",
  );
  assert.deepEqual(tracker.takeDepartures(), ["own"]);
  assert.deepEqual(tracker.takeDepartures(), []);
});

test("unspawn is not death and ownership loss stops later tracking", () => {
  const tracker = new OwnLifecycle();
  tracker.seenOwn(1, "own");
  tracker.onEvent({ type: ApiEventType.ObjectUnspawn, target: 1 }, "us");
  assert.deepEqual(tracker.takeDepartures(), []);
  tracker.onEvent(
    {
      type: ApiEventType.ObjectOwnerChange,
      target: 1,
      prevOwnerName: "us",
      newOwnerName: "other",
    },
    "us",
  );
  assert.deepEqual(tracker.takeDepartures(), ["own"]);
  tracker.onEvent(
    { type: ApiEventType.ObjectDestroy, target: 1, attackerInfo: undefined },
    "us",
  );
  assert.deepEqual(tracker.takeDepartures(), []);
});
