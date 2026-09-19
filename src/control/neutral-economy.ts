import { distance2, type Observation, type Unit } from "../model.js";
import type { CombatMission } from "./contracts.js";

export const isEngineer = (u: Unit) =>
  ["ENGINEER", "SENGINEER"].includes(u.name);

/** One funded engineer per visible safe oil objective. No omniscient neutral lookup. */
export class NeutralEconomy {
  private lastEngineer?: string;
  private retryAfter = 0;
  plan(o: Observation): {
    mission?: Omit<CombatMission, "revision">;
    demand: number;
  } {
    const engineers = o.own.filter(isEngineer);
    if (
      this.lastEngineer &&
      !engineers.some((u) => u.ref === this.lastEngineer)
    )
      this.retryAfter = o.tick + 600;
    this.lastEngineer = engineers[0]?.ref;
    const targets = (o.techBuildings ?? []).filter(
      (b) =>
        distance2(b, o.home) <= 60 ** 2 &&
        !o.enemies.some(
          (e) =>
            (e.weaponRange ?? 0) > 0 &&
            distance2(e, b) <= ((e.weaponRange ?? 5) + 3) ** 2,
        ),
    );
    const origin = engineers[0] ?? o.home;
    const target = targets.sort(
      (a, b) => distance2(a, origin) - distance2(b, origin),
    )[0];

    return {
      demand: target && o.tick >= this.retryAfter ? 1 : 0,
      ...(engineers[0]
        ? {
            mission: {
              id: "capture-income",
              kind: "capture",
              units: [engineers[0].ref],
              destination: target ? { x: target.x, y: target.y } : o.home,
              target: target?.ref,
              objective: "capture-visible-income",
              engagement: { allowCrush: false },
            },
          }
        : {}),
    };
  }
}
