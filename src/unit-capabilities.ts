import type { UnitData, WeaponData } from "@chronodivide/game-api";

function combatWeapon(weapon?: WeaponData): weapon is WeaponData {
  // Spy MakeupKit has an infinite targeting range, but only applies disguise.
  return (
    !!weapon && !weapon.rules.neverUse && !weapon.warheadRules.makesDisguise
  );
}

export function combatWeaponRange(weapon?: WeaponData): number | undefined {
  return combatWeapon(weapon) ? weapon.maxRange : undefined;
}

/** Static combat capability of an owned or currently visible unit. */
export function combatCapabilities(unit: UnitData) {
  const weapons = [unit.primaryWeapon, unit.secondaryWeapon].filter(
    combatWeapon,
  );
  const ground = weapons.filter((w) => w.projectileRules.isAntiGround);
  // Pinned ArmorType: Light/Medium/Heavy = 3/4/5; Wood/Steel/Concrete = 6/7/8.
  return {
    weaponRange: Math.max(0, ...ground.map((w) => w.maxRange)),
    antiAir: weapons.some((w) => w.projectileRules.isAntiAir),
    canThreatenBuildings:
      !!(unit.rules.engineer || unit.rules.agent || unit.rules.infiltrate) ||
      ground.some((w) =>
        ([6, 7, 8] as const).some(
          (armor) => (w.warheadRules.verses.get(armor) ?? 0) > 0,
        ),
      ),
    canThreatenVehicles: ground.some((w) =>
      ([3, 4, 5] as const).some(
        (armor) => (w.warheadRules.verses.get(armor) ?? 0) > 0,
      ),
    ),
  };
}
