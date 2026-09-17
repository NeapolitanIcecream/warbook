import { test } from "node:test";
import assert from "node:assert/strict";
import type { UnitData } from "@chronodivide/game-api";
import { combatCapabilities } from "../src/unit-capabilities.js";

test("a dog's virtual scanner does not become a ranged anti-armor weapon", () => {
  const unit = {
    rules: {},
    primaryWeapon: {
      rules: { neverUse: false },
      maxRange: 1.5,
      projectileRules: { isAntiGround: true, isAntiAir: false },
      warheadRules: {
        verses: new Map([
          [0, 1],
          [1, 1],
          [2, 1],
        ]),
      },
    },
    secondaryWeapon: {
      rules: { neverUse: true },
      maxRange: 5,
      projectileRules: { isAntiGround: true, isAntiAir: true },
      warheadRules: {
        verses: new Map([
          [3, 1],
          [5, 1],
          [6, 1],
          [8, 1],
        ]),
      },
    },
  } as unknown as UnitData;
  assert.deepEqual(combatCapabilities(unit), {
    weaponRange: 1.5,
    antiAir: false,
    canThreatenBuildings: false,
    canThreatenVehicles: false,
  });
});

test("an unarmed engineer remains a building threat", () => {
  const result = combatCapabilities({ rules: { engineer: true } } as UnitData);
  assert.equal(result.canThreatenBuildings, true);
  assert.equal(result.canThreatenVehicles, false);
  assert.equal(result.weaponRange, 0);
});
