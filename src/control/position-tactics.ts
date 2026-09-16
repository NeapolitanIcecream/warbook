import {
  distance2,
  type Intent,
  type Observation,
  type Point,
} from "../model.js";
import { LocalCombat } from "./tactics.js";
import {
  currentEvidence,
  type CombatMission,
  type ControlResult,
  type ExecutionEvidence,
} from "./contracts.js";

/** Defenders occupy local posts; offensive missions still use the frozen local combat rules. */
export class PositionTactics extends LocalCombat {
  override readonly id: string = "position-tactics-v3";
  private lastPositionOrders = new Map<string, { key: string; tick: number }>();
  private slots = new Map<string, number>();
  private nextSlot = 0;
  private roles = new Map<string, string>();

  protected prepareMission(mission: CombatMission): void {
    const role = `${mission.id}:${mission.kind}`;
    for (const ref of mission.units)
      if (this.roles.get(ref) !== role) {
        this.roles.set(ref, role);
        this.lastPositionOrders.delete(ref);
        this.lastOrders.delete(ref);
      }
  }

  override control(
    o: Observation,
    mission: CombatMission,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult {
    this.prepareMission(mission);
    if (mission.kind !== "defend") return super.control(o, mission, evidence);
    const intents: Intent[] = [];
    const owns = new Map(o.own.map((u) => [u.ref, u]));
    const issue = (
      ref: string,
      key: string,
      intent: Intent,
      repeat: number,
    ) => {
      const previous = this.lastPositionOrders.get(ref);
      if (
        !previous ||
        (previous.key !== key && o.tick - previous.tick >= 30) ||
        o.tick - previous.tick >= repeat
      ) {
        this.lastPositionOrders.set(ref, { key, tick: o.tick });
        intents.push(intent);
      }
    };
    const base = mission.destination;
    let stationed = 0,
      deployed = 0;
    for (const ref of mission.units) {
      const unit = owns.get(ref);
      if (!unit || !base) continue;
      if (unit.type !== 3) {
        const close = o.enemies.filter(
          (e) =>
            (!e.airborne || unit.antiAir) &&
            distance2(e, base) <= 12 ** 2 &&
            distance2(e, unit) <= 6 ** 2,
        );
        const infantry = unit.crusher
          ? close
              .filter(
                (e) =>
                  e.type === 3 && !e.airborne && distance2(e, unit) <= 3 ** 2,
              )
              .sort((a, b) => distance2(a, unit) - distance2(b, unit))[0]
          : undefined;
        if (infantry) {
          issue(
            ref,
            `crush:${infantry.ref}`,
            {
              kind: "crush",
              refs: [ref],
              target: infantry.ref,
              task: mission.id,
            },
            60,
          );
          continue;
        }
        const target = close.sort(
          (a, b) =>
            (unit.antiAir ? Number(!!b.airborne) - Number(!!a.airborne) : 0) ||
            Number(b.type === 7) - Number(a.type === 7) ||
            a.hp / a.maxHp - b.hp / b.maxHp ||
            distance2(a, unit) - distance2(b, unit),
        )[0];
        if (target) {
          issue(
            ref,
            `attack:${target.ref}`,
            {
              kind: "attack",
              refs: [ref],
              target: target.ref,
              task: mission.id,
            },
            180,
          );
          continue;
        }
      }
      let slot = this.slots.get(ref);
      if (slot === undefined) this.slots.set(ref, (slot = this.nextSlot++));
      const offsets: Point[] = [
        { x: -2, y: 0 },
        { x: 0, y: -2 },
        { x: 2, y: 0 },
        { x: 0, y: 2 },
        { x: -2, y: -2 },
        { x: 2, y: 2 },
        { x: -2, y: 2 },
        { x: 2, y: -2 },
      ];
      const desired = {
        x: base.x + offsets[slot % offsets.length].x,
        y: base.y + offsets[slot % offsets.length].y,
      };
      // Only own, already observed footprints influence the fallback post.
      const free = (p: Point) =>
        !o.own.some(
          (b) =>
            b.type === 2 &&
            p.x >= b.x &&
            p.x < b.x + b.width &&
            p.y >= b.y &&
            p.y < b.y + b.height,
        );
      const point = free(desired)
        ? desired
        : (offsets
            .map((p) => ({ x: desired.x + 2 * p.x, y: desired.y + 2 * p.y }))
            .find(free) ?? desired);
      if (distance2(unit, point) > 2 ** 2) {
        if (unit.deployed)
          issue(
            ref,
            "undeploy",
            { kind: "deploy", refs: [ref], task: mission.id },
            180,
          );
        else
          issue(
            ref,
            `post:${point.x}:${point.y}`,
            { kind: "move", refs: [ref], ...point, task: mission.id },
            180,
          );
      } else {
        stationed++;
        if (false && unit.name === "E1") {
          if (unit.deployed) deployed++;
          else
            issue(
              ref,
              "deploy",
              { kind: "deploy", refs: [ref], task: mission.id },
              180,
            );
        } else
          issue(
            ref,
            "hold",
            { kind: "stop", refs: [ref], task: mission.id },
            Number.POSITIVE_INFINITY,
          );
      }
    }
    for (const ref of this.slots.keys())
      if (!owns.has(ref)) {
        this.slots.delete(ref);
        this.lastPositionOrders.delete(ref);
        this.roles.delete(ref);
        this.lastOrders.delete(ref);
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
        status: mission.units.length ? "active" : "idle",
        reason: "occupy-defensive-post",
        proposedIntents: intents.length,
        facts: {
          assignedUnits: mission.units.length,
          stationed,
          deployed,
          phase: mission.kind,
        },
        executionEvidence: currentEvidence(mission, evidence),
      },
    };
  }
}
