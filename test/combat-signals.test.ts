import { test } from "node:test";
import assert from "node:assert/strict";
import { combatSignals } from "../src/analysis/combat-signals.js";

const before = { id: 10, tick: 100, hp: 300, weapon: "105mm", cooldown: 0 };
test("combat signals preserve the observed interval without claiming a cause", () => {
  const signals = combatSignals(before, {
    ...before,
    tick: 103,
    hp: 235,
    cooldown: 58,
  });
  assert.deepEqual(signals.damage, {
    fromTick: 100,
    tick: 103,
    hpBefore: 300,
    hpAfter: 235,
  });
  assert.deepEqual(signals.cooldownRestart, {
    fromTick: 100,
    tick: 103,
    weapon: "105mm",
  });
});
test("weapon changes, missing samples, and different units do not create false firing signals", () => {
  assert.equal(
    combatSignals(before, {
      ...before,
      tick: 103,
      weapon: "other",
      cooldown: 58,
    }).cooldownRestart,
    undefined,
  );
  assert.deepEqual(
    combatSignals(before, { ...before, tick: 109, hp: 100, cooldown: 58 }),
    {},
  );
  assert.deepEqual(
    combatSignals(before, {
      ...before,
      id: 11,
      tick: 103,
      hp: 100,
      cooldown: 58,
    }),
    {},
  );
});
test("healing and ordinary cooldown decay are not damage or new firing evidence", () => {
  const signals = combatSignals(
    { ...before, cooldown: 30 },
    { ...before, tick: 103, hp: 320, cooldown: 27 },
  );
  assert.equal(signals.damage, undefined);
  assert.equal(signals.cooldownRestart, undefined);
});
