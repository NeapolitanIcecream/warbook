import { distance2, type Contact, type Unit } from "../model.js";

/** Shared short finishing commitment; this is an estimate, not a damage simulator. */
export function canFinishNearby(
  target: Contact | undefined,
  force: readonly Unit[],
): boolean {
  return (
    !!target &&
    target.hp <= force.length * 45 &&
    force.some((unit) => distance2(unit, target) <= 8 ** 2)
  );
}
