import type { UnitData, WeaponData } from "@chronodivide/game-api";

/** Static weapon capability of an owned or currently visible unit. NeverUse scanners do not fire. */
export function combatCapabilities(unit: UnitData) {
  const weapons = [unit.primaryWeapon, unit.secondaryWeapon].filter(
    (w): w is WeaponData => !!w && !w.rules.neverUse,
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
