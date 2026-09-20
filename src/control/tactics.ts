import { NativeOrders } from "./native-orders.js";
import { distance2, type Intent, type Observation } from "../model.js";
import {
  currentEvidence,
  type CombatMission,
  type AssessmentRequest,
  type ControlResult,
  type ExecutionEvidence,
  type TacticalAssessment,
  type TacticalController,
} from "./contracts.js";

/** Local engagement and native orders, bounded by the assigned combat mission. */
export class LocalCombat implements TacticalController {
  readonly id: string = "local-combat-v1";
  private readonly contactRadius = 14;
  private readonly crushRadius = 10;
  protected readonly orders = new NativeOrders();
  assess(o: Observation, request: AssessmentRequest): TacticalAssessment {
    const name = request.unitType;
    const factory = request.factoryType;
    const army = o.own.filter(
      (u) =>
        u.combat &&
        !["ENGINEER", "SENGINEER"].includes(u.name) &&
        (u.mobile || u.deployed) &&
        !u.harvester &&
        !u.mcv,
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
      _key: string,
      intent: Intent,
      _repeat: number,
    ) => {
      const unit = o.own.find((u) => u.ref === ref);
      if (unit && this.orders.allow(unit, intent, o.tick)) intents.push(intent);
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
              distance2(unit, e) < this.contactRadius ** 2,
          )
          .sort(
            (a, b) =>
              (unit.antiAir
                ? Number(!!b.airborne) - Number(!!a.airborne)
                : 0) || distance2(unit, a) - distance2(unit, b),
          );
        const preferred = nearby.find((e) => e.ref === mission.target);
        const immediateArmor = preferred
          ? nearby.find(
              (e) =>
                e.type === 7 &&
                !["AMCV", "SMCV", "CMIN", "HARV"].includes(e.name) &&
                distance2(e, unit) <= 6 ** 2,
            )
          : undefined;
        const target = immediateArmor ?? preferred ?? nearby[0];
        if (
          mission.engagement.allowCrush &&
          unit.crusher &&
          target?.type === 3 &&
          !target.airborne &&
          distance2(unit, target) < this.crushRadius ** 2
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

/** Experimental: use native group movement for marching tanks sharing one goal. */
export class GroupedAdvance extends LocalCombat {
  override readonly id = "grouped-advance-v1";
  override control(
    o: Observation,
    mission: CombatMission,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult {
    const result = super.control(o, mission, evidence);
    if (mission.kind !== "advance") return result;
    const tankTypes = new Map(
      o.own
        .filter((u) => u.name === "MTNK" || u.name === "HTNK")
        .map((u) => [u.ref, u.name]),
    );
    const groups = new Map<
      string,
      Extract<Intent, { kind: "attackMove" | "move" }>
    >();
    const intents: Intent[] = [];
    for (const intent of result.intents) {
      if (
        intent.kind !== "attackMove" ||
        intent.refs.length !== 1 ||
        !tankTypes.has(intent.refs[0])
      ) {
        intents.push(intent);
        continue;
      }
      const key = JSON.stringify([
        tankTypes.get(intent.refs[0]),
        intent.x,
        intent.y,
        intent.task,
      ]);
      const group = groups.get(key);
      if (group) group.refs.push(...intent.refs);
      else {
        const grouped = { ...intent, refs: [...intent.refs] };
        groups.set(key, grouped);
        intents.push(grouped);
      }
    }
    return {
      ...result,
      intents,
      report: {
        ...result.report,
        proposedIntents: intents.length,
        facts: {
          ...result.report.facts,
          mergedMarchOrders: result.intents.length - intents.length,
        },
      },
    };
  }
}
