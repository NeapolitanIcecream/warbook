import { distance2, type Intent, type Observation } from "../model.js";
import {
  currentEvidence,
  type CombatMission,
  type ControlResult,
  type ExecutionEvidence,
  type TacticalAssessment,
  type TacticalController,
} from "./contracts.js";

/** Local engagement and native orders, bounded by the assigned combat mission. */
export class LocalCombat implements TacticalController {
  readonly id: string = "local-combat-v1";
  private lastOrders = new Map<string, { tick: number; key: string }>();
  assess(o: Observation): TacticalAssessment {
    const name = o.side === 0 ? "MTNK" : "HTNK";
    const factory = o.side === 0 ? "GAWEAP" : "NAWEAP";
    const army = o.own.filter(
      (u) => u.combat && (u.mobile || u.deployed) && !u.harvester && !u.mcv,
    );
    const factories = o.own.filter((b) => b.type === 2 && b.name === factory);
    return {
      army,
      observedArmor: o.own.filter((u) => u.name === name).length,
      armorOutsideFactories: army.filter(
        (u) =>
          u.name === name &&
          !factories.some(
            (b) =>
              u.x >= b.x &&
              u.x < b.x + b.width &&
              u.y >= b.y &&
              u.y < b.y + b.height,
          ),
      ).length,
    };
  }
  control(
    o: Observation,
    mission: CombatMission,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult {
    const intents: Intent[] = [];
    const holding = mission.kind === "assemble";
    const order = (
      ref: string,
      key: string,
      intent: Intent,
      repeat: number,
    ) => {
      const prev = this.lastOrders.get(ref);
      if (
        !prev ||
        (prev.key !== key && o.tick - prev.tick >= 30) ||
        o.tick - prev.tick >= repeat
      ) {
        this.lastOrders.set(ref, { tick: o.tick, key });
        intents.push(intent);
      }
    };
    const units = new Map(o.own.map((u) => [u.ref, u]));
    if (mission.destination)
      for (const ref of mission.units) {
        const unit = units.get(ref);
        if (!unit) continue;
        const nearby = [...o.enemies]
          .filter(
            (e) =>
              (!e.airborne || unit.antiAir) &&
              distance2(unit, e) < mission.engagement.contactRadius ** 2,
          )
          .sort(
            (a, b) =>
              (unit.antiAir
                ? Number(!!b.airborne) - Number(!!a.airborne)
                : 0) || distance2(unit, a) - distance2(unit, b),
          );
        const target = nearby[0];
        if (
          mission.engagement.allowCrush &&
          unit.crusher &&
          target?.type === 3 &&
          !target.airborne &&
          distance2(unit, target) < mission.engagement.crushRadius ** 2
        ) {
          order(
            ref,
            "crush:" + target.ref,
            {
              kind: "crush",
              refs: [ref],
              target: target.ref,
              ...(holding ? { task: "counter-defense" } : {}),
            },
            60,
          );
        } else if (target) {
          order(
            ref,
            "attack:" + target.ref,
            {
              kind: "attack",
              refs: [ref],
              target: target.ref,
              ...(holding ? { task: "counter-defense" } : {}),
            },
            180,
          );
        } else {
          const goal = unit.antiAir
            ? mission.destination
            : (mission.groundDestination ?? mission.destination);
          order(
            ref,
            `advance:${goal.x}:${goal.y}`,
            {
              kind: "attackMove",
              refs: [ref],
              x: goal.x,
              y: goal.y,
              ...(holding ? { task: "counter-rally" } : {}),
            },
            450,
          );
        }
      }
    return {
      origin: {
        id: mission.id,
        revision: mission.revision,
        controller: "tactics",
      },
      intents,
      report: {
        task: { id: mission.id, revision: mission.revision },
        status: !mission.units.length
          ? "idle"
          : !mission.destination
            ? "blocked"
            : holding
              ? "waiting"
              : "active",
        reason: !mission.units.length
          ? "no-force"
          : !mission.destination
            ? "no-destination"
            : holding
              ? "opening-assembly"
              : "advance-and-local-engagement",
        proposedIntents: intents.length,
        facts: {
          assignedUnits: mission.units.length,
          visibleContacts: o.enemies.length,
          phase: mission.kind,
        },
        executionEvidence: currentEvidence(mission, evidence),
      },
    };
  }
}
