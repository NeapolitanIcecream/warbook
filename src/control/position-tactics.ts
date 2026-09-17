import {
  distance2,
  weaponDistance2,
  type Intent,
  type Observation,
  type Point,
} from "../model.js";
import { LocalCombat } from "./tactics.js";
import { StrikeTactics } from "./strike-tactics.js";
import { ScoutTactics } from "./reconnaissance.js";
import {
  currentEvidence,
  type CombatMission,
  type ControlResult,
  type ExecutionEvidence,
} from "./contracts.js";

/** Defense movement and deployment serve visible engagements; native orders handle travel. */
export class PositionTactics extends LocalCombat {
  override readonly id: string = "position-tactics-v6";
  private lastPositionOrders = new Map<string, { key: string; tick: number }>();
  private slots = new Map<string, number>();
  private nextSlot = 0;
  private roles = new Map<string, string>();
  private targets = new Map<string, string>();
  private readonly scouts = new ScoutTactics();
  private readonly strike = new StrikeTactics();

  protected prepareMission(mission: CombatMission): void {
    const role = `${mission.id}:${mission.kind}`;
    for (const ref of mission.units)
      if (this.roles.get(ref) !== role) {
        const continuingDefense =
          this.roles.get(ref)?.endsWith(":defend") &&
          mission.kind === "defend" &&
          !mission.engagement.interrupt;
        this.roles.set(ref, role);
        this.strike.handoff(ref, mission.id);
        if (!continuingDefense) {
          this.lastPositionOrders.delete(ref);
          this.targets.delete(ref);
        }
        this.lastOrders.delete(ref);
      }
  }

  override control(
    o: Observation,
    mission: CombatMission,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult {
    this.prepareMission(mission);
    if (mission.kind === "scout")
      return this.scouts.control(o, mission, evidence);
    if (mission.kind === "advance")
      return this.strike.control(o, mission, evidence);
    if (mission.kind !== "defend" && mission.kind !== "assemble")
      return super.control(o, mission, evidence);
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
        (previous.key !== key &&
          (o.tick - previous.tick >= 30 ||
            previous.key === "deploy" ||
            previous.key === "undeploy")) ||
        o.tick - previous.tick >= repeat
      ) {
        this.lastPositionOrders.set(ref, { key, tick: o.tick });
        intents.push(intent);
      }
    };
    const base = mission.destination;
    let stationed = 0,
      deployed = 0,
      engaging = 0;
    for (const ref of mission.units) {
      const unit = owns.get(ref);
      if (!unit || !base) continue;
      if (unit.type === 3) {
        const range =
          unit.name === "E1"
            ? (unit.deployedWeaponRange ?? 5)
            : (unit.weaponRange ?? 4);
        const targets = o.enemies.filter(
          (e) =>
            (!e.airborne || unit.antiAir) &&
            ((!mission.engagement.interrupt &&
              weaponDistance2(e, unit) <= range ** 2) ||
              ((mission.threats
                ? mission.threats.includes(e.ref)
                : distance2(e, base) <= 12 ** 2) &&
                (weaponDistance2(e, unit) <= range ** 2 ||
                  (mission.protectedAssets
                    ? mission.protectedAssets.some((ref) => {
                        const asset = owns.get(ref);
                        return (
                          asset &&
                          distance2(e, {
                            x: Math.max(
                              asset.x,
                              Math.min(e.x, asset.x + asset.width),
                            ),
                            y: Math.max(
                              asset.y,
                              Math.min(e.y, asset.y + asset.height),
                            ),
                          }) <=
                            ((e.weaponRange ?? 5) + 1) ** 2
                        );
                      })
                    : distance2(e, base) <= 6 ** 2)))),
        );
        const previousTarget = targets.find(
          (e) =>
            e.ref === this.targets.get(ref) &&
            weaponDistance2(e, unit) <= range ** 2,
        );
        const target =
          previousTarget ??
          targets.sort(
            (a, b) =>
              Number(weaponDistance2(b, unit) <= range ** 2) -
                Number(weaponDistance2(a, unit) <= range ** 2) ||
              weaponDistance2(a, unit) - weaponDistance2(b, unit),
          )[0];
        if (target) {
          this.targets.set(ref, target.ref);
          engaging++;
          const distance = Math.sqrt(weaponDistance2(unit, target));
          if (unit.name === "E1" && unit.deployed && distance > range + 0.25) {
            issue(
              ref,
              "undeploy",
              { kind: "deploy", refs: [ref], task: mission.id },
              180,
            );
          } else if (
            unit.name === "E1" &&
            !unit.deployed &&
            (distance <= range || (unit.attackState ?? 0) >= 3)
          ) {
            issue(
              ref,
              "deploy",
              { kind: "deploy", refs: [ref], task: mission.id },
              180,
            );
          } else {
            if (unit.deployed) deployed++;
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
          }
          continue;
        }
        this.targets.delete(ref);
      } else {
        const close = o.enemies.filter(
          (e) =>
            (!e.airborne || unit.antiAir) &&
            distance2(e, base) <= 12 ** 2 &&
            distance2(e, unit) <= 6 ** 2,
        );
        const infantry =
          unit.crusher && mission.engagement.allowCrush
            ? close
                .filter(
                  (e) =>
                    e.type === 3 &&
                    !e.airborne &&
                    !close.some(
                      (other) =>
                        other.type === 7 &&
                        distance2(other, unit) < distance2(e, unit),
                    ),
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
          engaging++;
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
      if (unit.type === 3) {
        const dx = base.x - o.home.x,
          dy = base.y - o.home.y;
        const length = Math.hypot(dx, dy) || 1;
        const side = [0, -1, 1, -2, 2, -3, 3][slot % 7];
        desired.x = Math.round(base.x - (dy / length) * side);
        desired.y = Math.round(base.y + (dx / length) * side);
      }
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
        if (unit.deployed) deployed++;
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
        this.targets.delete(ref);
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
        reason: engaging ? "engage-visible-threat" : "cover-approach",
        proposedIntents: intents.length,
        facts: {
          assignedUnits: mission.units.length,
          stationed,
          deployed,
          engaging,
          phase: mission.kind,
        },
        executionEvidence: currentEvidence(mission, evidence),
      },
    };
  }
}
