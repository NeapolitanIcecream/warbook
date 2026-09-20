import {
  distance2,
  weaponDistance2,
  type Intent,
  type Observation,
  type Point,
} from "../model.js";
import { LocalCombat } from "./tactics.js";
import {
  localArmorTarget,
  supportedTarget,
  rotationPost,
  rangedFallback,
} from "./combat-targets.js";
import { StrikeTactics } from "./strike-tactics.js";
import { ScoutTactics } from "./reconnaissance.js";
import { HarvesterTactics } from "./harvesters.js";
import {
  currentEvidence,
  type CombatMission,
  type ControlResult,
  type ExecutionEvidence,
} from "./contracts.js";

/** Defense movement and deployment serve visible engagements; native orders handle travel. */
export class PositionTactics extends LocalCombat {
  override readonly id: string = "position-tactics-v7";
  private lastPositionOrders = new Map<string, { key: string; tick: number }>();
  private roles = new Map<string, string>();
  private targets = new Map<string, string>();
  private motion = new Map<string, { point: Point; since: number }>();
  private yieldingUntil = new Map<string, number>();
  private readonly scouts = new ScoutTactics();
  private readonly strike = new StrikeTactics();
  private readonly harvesters = new HarvesterTactics();

  protected prepareMission(mission: CombatMission): void {
    const role = `${mission.id}:${mission.kind}`;
    for (const ref of mission.units)
      if (this.roles.get(ref) !== role) {
        const continuingDefense =
          this.roles.get(ref)?.endsWith(":defend") &&
          mission.kind === "defend" &&
          !mission.engagement.interrupt;
        this.roles.set(ref, role);
        this.motion.delete(ref);
        this.yieldingUntil.delete(ref);
        this.strike.handoff(ref, mission.id);
        if (!continuingDefense) {
          this.lastPositionOrders.delete(ref);
          this.targets.delete(ref);
          this.orders.forget(ref);
        }
      }
  }

  override control(
    o: Observation,
    mission: CombatMission,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult {
    this.prepareMission(mission);
    if (mission.kind === "harvest")
      return this.harvesters.control(o, mission, evidence);
    if (mission.kind === "scout")
      return this.scouts.control(o, mission, evidence);
    if (mission.kind === "screen") {
      const intents: Intent[] = [];
      for (const ref of mission.units) {
        const unit = o.own.find((u) => u.ref === ref);
        if (!unit || !mission.destination) continue;
        const target = o.enemies
          .filter(
            (e) =>
              e.type === 3 &&
              !e.airborne &&
              distance2(e, unit) <= 7 ** 2 &&
              distance2(e, mission.destination!) <= 8 ** 2,
          )
          .sort((a, b) => distance2(a, unit) - distance2(b, unit))[0];
        const key = target
          ? `screen:${target.ref}`
          : `screen:${mission.destination.x}:${mission.destination.y}`;
        const intent: Intent = target
          ? {
              kind: "attack",
              refs: [ref],
              target: target.ref,
              task: mission.id,
            }
          : {
              kind: "attackMove",
              refs: [ref],
              ...mission.destination,
              task: mission.id,
            };
        if (this.orders.allow(unit, intent, o.tick)) {
          intents.push(intent);
          this.lastPositionOrders.set(ref, { key, tick: o.tick });
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
          status: "active",
          reason: "screen-supported-force",
          proposedIntents: intents.length,
          facts: { assignedUnits: mission.units.length },
          executionEvidence: currentEvidence(mission, evidence),
        },
      };
    }
    if (mission.kind === "capture") {
      const intents: Intent[] = [];
      const target = o.techBuildings?.find((b) => b.ref === mission.target);
      for (const ref of mission.units) {
        const unit = o.own.find((u) => u.ref === ref);
        if (!unit) continue;
        const danger = o.enemies.some(
          (e) =>
            (e.weaponRange ?? 0) > 0 &&
            distance2(e, unit) <= ((e.weaponRange ?? 5) + 2) ** 2,
        );
        const signature = danger ? "capture-retreat" : `capture:${target?.ref}`;
        const intent: Intent =
          danger || !target
            ? { kind: "move", refs: [ref], ...o.home, task: mission.id }
            : {
                kind: "capture",
                refs: [ref],
                target: target.ref,
                task: mission.id,
              };
        if (this.orders.allow(unit, intent, o.tick)) {
          intents.push(intent);
          this.lastPositionOrders.set(ref, { key: signature, tick: o.tick });
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
          status: "active",
          reason: "capture-visible-income",
          proposedIntents: intents.length,
          facts: { assignedUnits: mission.units.length },
          executionEvidence: currentEvidence(mission, evidence),
        },
      };
    }
    const infantryAdvance =
      mission.kind === "advance" &&
      mission.units.length > 0 &&
      mission.units.every((ref) =>
        o.own.some((u) => u.ref === ref && u.type === 3),
      );
    if (mission.kind === "advance" && !infantryAdvance)
      return this.strike.control(o, mission, evidence);
    if (
      mission.kind !== "defend" &&
      mission.kind !== "assemble" &&
      mission.kind !== "withdraw" &&
      !infantryAdvance
    )
      return super.control(o, mission, evidence);
    const intents: Intent[] = [];
    const owns = new Map(o.own.map((u) => [u.ref, u]));
    const issue = (ref: string, key: string, intent: Intent) => {
      const unit = owns.get(ref);
      if (unit && this.orders.allow(unit, intent, o.tick)) {
        this.lastPositionOrders.set(ref, { key, tick: o.tick });
        intents.push(intent);
      }
    };
    const route = o.routes?.find(
      (r) =>
        r.task === mission.id &&
        mission.destination &&
        distance2(r.towards, mission.destination) <= 2 ** 2,
    );
    const base = route?.post ?? mission.destination;
    const armor = mission.units.flatMap((ref) => {
      const u = owns.get(ref);
      return u?.type === 7 && u.combat && !u.harvester ? [u] : [];
    });
    const sharedTarget =
      base && mission.kind !== "withdraw"
        ? supportedTarget(o.enemies, armor, base)
        : undefined;
    let stationed = 0,
      deployed = 0,
      engaging = 0,
      rotating = 0,
      givingWay = 0;
    for (const ref of mission.units) {
      const unit = owns.get(ref);
      if (!unit || !base) continue;
      if (unit.type === 3 && mission.kind !== "withdraw") {
        const range =
          unit.name === "E1"
            ? (unit.deployedWeaponRange ?? 5)
            : (unit.weaponRange ?? 4);
        const supportingFight = (enemy: Observation["enemies"][number]) =>
          mission.kind === "defend" &&
          o.own.some(
            (ally) =>
              ally.type === 7 &&
              ally.combat &&
              !ally.harvester &&
              this.roles.get(ally.ref)?.endsWith(":defend") &&
              distance2(ally, unit) <= 8 ** 2 &&
              weaponDistance2(ally, enemy) <= (ally.weaponRange ?? 5) ** 2,
          );
        const targets = o.enemies.filter(
          (e) =>
            (!e.airborne || unit.antiAir) &&
            ((!mission.engagement.interrupt &&
              weaponDistance2(e, unit) <= range ** 2) ||
              ((mission.threats
                ? mission.threats.includes(e.ref)
                : distance2(e, base) <= 12 ** 2) &&
                (weaponDistance2(e, unit) <= range ** 2 ||
                  supportingFight(e) ||
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
            issue(ref, "undeploy", {
              kind: "deploy",
              refs: [ref],
              task: mission.id,
            });
          } else if (
            unit.name === "E1" &&
            !unit.deployed &&
            (distance <= range || (unit.attackState ?? 0) >= 3)
          ) {
            issue(ref, "deploy", {
              kind: "deploy",
              refs: [ref],
              task: mission.id,
            });
          } else {
            if (unit.deployed) deployed++;
            issue(ref, `attack:${target.ref}`, {
              kind: "attack",
              refs: [ref],
              target: target.ref,
              task: mission.id,
            });
          }
          continue;
        }
        this.targets.delete(ref);
      } else if (mission.kind !== "withdraw") {
        const screen = rangedFallback(unit, armor, o.enemies);
        if (screen) {
          issue(ref, `screen:${screen.x}:${screen.y}`, {
            kind: "move",
            refs: [ref],
            ...screen,
            task: mission.id,
          });
          continue;
        }
        const close = o.enemies.filter(
          (e) =>
            (!e.airborne || unit.antiAir) &&
            distance2(e, base) <= 12 ** 2 &&
            distance2(e, unit) <= 6 ** 2,
        );
        if (close.length && this.yieldingUntil.has(ref)) {
          this.yieldingUntil.delete(ref);
          this.lastPositionOrders.delete(ref);
        }
        const infantry =
          unit.crusher &&
          (unit.weaponRange ?? 0) < 8 &&
          mission.engagement.allowCrush &&
          !sharedTarget
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
          issue(ref, `crush:${infantry.ref}`, {
            kind: "crush",
            refs: [ref],
            target: infantry.ref,
            task: mission.id,
          });
          continue;
        }
        const target = localArmorTarget(unit, close, sharedTarget);
        const rotation = rotationPost(unit, armor, close);
        if (rotation) {
          rotating++;
          issue(ref, `rotate:${rotation.x}:${rotation.y}`, {
            kind: "move",
            refs: [ref],
            ...rotation,
            task: mission.id,
          });
          continue;
        }
        if (target) {
          engaging++;
          issue(ref, `attack:${target.ref}`, {
            kind: "attack",
            refs: [ref],
            target: target.ref,
            task: mission.id,
          });
          continue;
        }
      }
      if (unit.type === 7 && mission.kind !== "withdraw") {
        const position = unit.position ?? unit;
        let motion = this.motion.get(ref);
        if (
          !motion ||
          distance2(position, motion.point) >= 0.25 ** 2 ||
          !this.lastPositionOrders.get(ref)?.key.startsWith("post:")
        ) {
          motion = { point: { x: position.x, y: position.y }, since: o.tick };
          this.motion.set(ref, motion);
        }
        const until = this.yieldingUntil.get(ref);
        if (until !== undefined && o.tick < until) {
          givingWay++;
          continue;
        }
        if (until !== undefined) this.yieldingUntil.delete(ref);
        const danger = o.enemies.some(
          (e) =>
            e.canThreatenVehicles !== false &&
            (e.weaponRange ?? 0) > 0 &&
            weaponDistance2(unit, e) <= ((e.weaponRange ?? 5) + 2) ** 2,
        );
        if (
          o.tick - motion.since >= 90 &&
          distance2(unit, base) > 2 ** 2 &&
          !danger &&
          o.own.some(
            (other) =>
              other.ref !== ref &&
              distance2(unit, other) <= 2 ** 2 &&
              this.roles.get(other.ref)?.endsWith(":withdraw"),
          )
        ) {
          issue(ref, "give-way", {
            kind: "scatter",
            refs: [ref],
            task: mission.id,
          });
          this.yieldingUntil.set(ref, o.tick + 90);
          givingWay++;
          continue;
        }
      }
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
      // Ground posts are validated; arbitrary vehicle offsets can land in a cliff.
      const desired = {
        x: base.x,
        y: base.y,
        ...(base.onBridge ? { onBridge: true } : {}),
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
        : free(unit) && distance2(unit, base) <= 4 ** 2
          ? { x: unit.x, y: unit.y }
          : (offsets
              .map((p) => ({ x: desired.x + 2 * p.x, y: desired.y + 2 * p.y }))
              .find(free) ?? desired);
      if (distance2(unit, point) > (unit.type === 3 ? 1 : 2) ** 2) {
        if (unit.deployed)
          issue(ref, "undeploy", {
            kind: "deploy",
            refs: [ref],
            task: mission.id,
          });
        else
          issue(ref, `post:${point.x}:${point.y}`, {
            kind: "move",
            refs: [ref],
            ...point,
            task: mission.id,
          });
      } else {
        stationed++;
        if (unit.deployed) deployed++;
        if ((unit.attackState ?? 0) >= 3) continue;
        issue(ref, "hold", { kind: "stop", refs: [ref], task: mission.id });
      }
    }
    for (const ref of this.roles.keys())
      if (!owns.has(ref)) {
        this.lastPositionOrders.delete(ref);
        this.roles.delete(ref);
        this.orders.forget(ref);
        this.targets.delete(ref);
        this.motion.delete(ref);
        this.yieldingUntil.delete(ref);
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
        reason: givingWay
          ? "give-way-to-withdrawal"
          : mission.kind === "withdraw"
            ? "withdraw-to-support"
            : engaging
              ? "engage-visible-threat"
              : "cover-approach",
        proposedIntents: intents.length,
        facts: {
          assignedUnits: mission.units.length,
          stationed,
          deployed,
          engaging,
          rotating,
          givingWay,
          phase: mission.kind,
        },
        executionEvidence: currentEvidence(mission, evidence),
      },
    };
  }
}
