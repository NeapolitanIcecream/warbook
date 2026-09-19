import {
  distance2,
  weaponDistance2,
  type Contact,
  type Point,
  type Unit,
} from "../model.js";

/** A shared operational estimate, not a damage simulator. */
export function antiArmorPower(e: Contact): number {
  if (e.airborne || !(e.weaponRange ?? 0) || e.canThreatenVehicles === false)
    return 0;
  const value =
    e.type === 2
      ? 0.45
      : e.type === 3
        ? e.name === "E1" && e.deployed
          ? 0.37
          : 0.12
        : e.name === "FV"
          ? 0.6
          : 1;
  return value * Math.sqrt(e.hp / e.maxHp);
}

/** Both attack and defense concentrate guns that can actually join this contact. */
export function supportedTarget(
  enemies: readonly Contact[],
  armor: readonly Unit[],
  center: Point,
  radius = 12,
): Contact | undefined {
  return enemies
    .filter(
      (e) =>
        !e.airborne &&
        e.type !== 3 &&
        (e.weaponRange ?? 0) > 0 &&
        distance2(e, center) <= radius ** 2,
    )
    .map((enemy) => ({
      enemy,
      guns: armor.filter(
        (u) => weaponDistance2(u, enemy) <= ((u.weaponRange ?? 5) + 1) ** 2,
      ).length,
    }))
    .filter((t) => t.guns > 0)
    .sort(
      (a, b) =>
        Number(b.enemy.type === 7) - Number(a.enemy.type === 7) ||
        b.guns - a.guns ||
        a.enemy.hp / a.enemy.maxHp - b.enemy.hp / b.enemy.maxHp,
    )[0]?.enemy;
}

export function localArmorTarget(
  unit: Unit,
  enemies: readonly Contact[],
  shared?: Contact,
): Contact | undefined {
  const close = enemies
    .filter(
      (e) => (!e.airborne || unit.antiAir) && distance2(e, unit) <= 6 ** 2,
    )
    .sort(
      (a, b) =>
        (unit.antiAir ? Number(!!b.airborne) - Number(!!a.airborne) : 0) ||
        Number(b.type === 7) - Number(a.type === 7) ||
        a.hp / a.maxHp - b.hp / b.maxHp ||
        distance2(a, unit) - distance2(b, unit),
    );
  return unit.antiAir && close[0]?.airborne
    ? close[0]
    : shared && weaponDistance2(shared, unit) <= 9 ** 2
      ? shared
      : close[0];
}

/** A wounded front tank rotates behind a healthy firing peer, not all the way home.
 * The destination is an occupied friendly tile, so native movement resolves spacing. */
export function rotationPost(
  unit: Unit,
  force: readonly Unit[],
  enemies: readonly Contact[],
): Point | undefined {
  if (unit.hp / unit.maxHp > 0.3 || unit.onBridge) return;
  const threats = enemies.filter(
    (e) =>
      !e.airborne &&
      e.type !== 3 &&
      (e.weaponRange ?? 0) > 0 &&
      weaponDistance2(unit, e) <= ((e.weaponRange ?? 5) + 1) ** 2,
  );
  if (!threats.length) return;
  const nearest = (u: Unit) =>
    Math.min(...threats.map((e) => weaponDistance2(u, e)));
  const peer = force
    .filter(
      (a) =>
        a.ref !== unit.ref &&
        !a.onBridge &&
        a.hp / a.maxHp >= 0.6 &&
        distance2(a, unit) <= 6 ** 2 &&
        nearest(a) > nearest(unit) + 4,
    )
    .sort((a, b) => nearest(b) - nearest(a))[0];
  return peer ? { x: peer.x, y: peer.y } : undefined;
}
