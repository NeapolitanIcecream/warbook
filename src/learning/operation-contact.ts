import { distance2, weaponDistance2 } from "../model.js";
import type { OperationContext } from "../control/operation-provider.js";
import { isArmor } from "./launch.js";

export const CONTACT_SCHEMA = "operation-contact-v1";
export const CONTACT_SIZE = 5;
export type ContactInput = "local" | "zero";

/** Current visible contact around the actual main group, excluding travelling
 * reinforcements and independent guards. Range coverage is geometry, not a claim
 * about line of fire, weapon cooldown or predicted combat outcome. */
export function operationContactFacts(c: OperationContext): number[] {
  const refs =
    c.state.order?.kind === "withdraw" ? c.state.withdrawing : c.state.assault;
  const force = c.observation.own.filter((u) => refs.has(u.ref));
  const enemies = c.observation.enemies.filter(
    (e) =>
      !e.airborne &&
      e.canThreatenVehicles !== false &&
      ((e.weaponRange ?? 0) > 0 || isArmor(e)),
  );
  if (!force.length || !enemies.length) return [1, 0, 0, 0, 0];
  const nearest = (e: (typeof enemies)[number]) =>
    Math.min(...force.map((u) => distance2(u, e)));
  const armorDistances = enemies.filter(isArmor).map(nearest);
  return [
    Math.min(32, Math.sqrt(Math.min(...enemies.map(nearest)))) / 32,
    Math.min(32, armorDistances.filter((d) => d <= 6 ** 2).length) / 16,
    Math.min(32, armorDistances.filter((d) => d <= 12 ** 2).length) / 16,
    force.filter((u) =>
      enemies.some(
        (e) =>
          (e.weaponRange ?? 0) > 0 &&
          weaponDistance2(e, u) <= e.weaponRange! ** 2,
      ),
    ).length / force.length,
    force.filter(
      (u) =>
        (u.weaponRange ?? 0) > 0 &&
        enemies.some((e) => weaponDistance2(u, e) <= u.weaponRange! ** 2),
    ).length / force.length,
  ];
}

/** Refuse ambiguous artifacts: a missing ablation label must not silently enable
 * new observations or replay a control arm with treatment inputs. */
export function contactInputFor(model: {
  schema: string;
  contactInput?: ContactInput;
}): ContactInput | undefined {
  if (model.schema === CONTACT_SCHEMA) {
    if (model.contactInput !== "local" && model.contactInput !== "zero")
      throw new Error("Contact model requires local/zero observation mode");
    return model.contactInput;
  }
  if (model.contactInput !== undefined)
    throw new Error("Contact input requires the contact schema");
  return undefined;
}
