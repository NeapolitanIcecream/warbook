import {
  distance2,
  weaponDistance2,
  type Contact,
  type Intent,
  type Observation,
  type Point,
  type Unit,
} from "../model.js";
import {
  currentEvidence,
  type CombatMission,
  type ControlResult,
  type ExecutionEvidence,
} from "./contracts.js";
import { formedUnits, rendezvous } from "./formation.js";
import { LocalCombat } from "./tactics.js";
import {
  supportedTarget,
  localArmorTarget,
  rotationPost,
  antiArmorPower,
} from "./combat-targets.js";
import { canFinishNearby } from "./finishing.js";

const armor = (u: Unit) => ["MTNK", "HTNK"].includes(u.name);
const hardTarget = (e: Contact) =>
  !e.airborne &&
  e.type !== 3 &&
  (e.weaponRange ?? 0) > 0 &&
  e.canThreatenVehicles !== false;

/** Keep a supported fighting core; native orders still choose legal paths and perform shooting. */
export class StrikeTactics extends LocalCombat {
  override readonly id = "supported-strike-v2";
  private leaders = new Map<string, string>();
  private trails = new Map<string, Point[]>();
  private retreats = new Map<string, { point: Point; until: number }>();
  private waits = new Map<string, number>();
  private heldContacts = new Map<string, { point: Point; goal: Point }>();

  handoff(ref: string, mission: string) {
    this.lastOrders.delete(ref);
    this.retreats.delete(ref);
  }

  override control(
    o: Observation,
    mission: CombatMission,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult {
    const route = o.routes?.find(
      (r) =>
        r.task === mission.id &&
        mission.destination &&
        distance2(r.towards, mission.destination) < 4 ** 2,
    );
    const march = route?.waypoint ?? mission.destination;
    const members = o.own.filter((u) => mission.units.includes(u.ref));
    const tanks = members.filter(armor);
    if (!mission.destination || !tanks.length)
      return super.control(o, mission, evidence);
    const previousLeader = tanks.find(
      (u) => u.ref === this.leaders.get(mission.id),
    );
    const core = formedUnits(tanks, previousLeader ?? mission.destination);
    const coreIds = new Set(core.map((u) => u.ref));
    const leader = core.find((u) => u.ref === previousLeader?.ref) ?? core[0];
    this.leaders.set(mission.id, leader.ref);
    const rally = rendezvous(core);
    const hard = o.enemies.filter(hardTarget);
    const threats = o.enemies.filter((e) => antiArmorPower(e) > 0);
    for (const u of members)
      if (!u.onBridge && !threats.some((e) => distance2(u, e) <= 10 ** 2)) {
        const trail = this.trails.get(u.ref) ?? [];
        if (!trail.length || distance2(trail[trail.length - 1], u) >= 3 ** 2)
          this.trails.set(u.ref, [...trail.slice(-7), { x: u.x, y: u.y }]);
      }
    const nearby = hard.filter((e) =>
      core.some((u) => distance2(e, u) <= 10 ** 2),
    );
    const preferred = o.enemies.find((e) => e.ref === mission.target);
    const finishNow = canFinishNearby(preferred, core);
    let held = this.heldContacts.get(mission.id);
    if (held && distance2(held.goal, mission.destination) > 16 ** 2) {
      this.heldContacts.delete(mission.id);
      held = undefined;
    }
    const contactThreats = threats.filter((e) =>
      held
        ? distance2(e, held.point) <= 12 ** 2
        : core.some((u) => distance2(e, u) <= 10 ** 2),
    );
    // Only guns covering the contact line count fully. Deployed rear infantry
    // cannot project all its damage through the front rank or across the base.
    const firingPositions = held ? [held.point] : core;
    const enemyPower = contactThreats.reduce((n, e) => {
      const range = e.weaponRange ?? 5;
      const distance = Math.min(
        ...firingPositions.map((u) => weaponDistance2(u, e)),
      );
      const coverage =
        distance <= (range + 1.5) ** 2
          ? 1
          : e.type === 7 && distance <= (range + 4) ** 2
            ? 0.5
            : 0;
      return n + antiArmorPower(e) * coverage;
    }, 0);
    const supportPower = o.own
      .filter(
        (u) =>
          !coreIds.has(u.ref) &&
          ((u.type === 2 && (u.weaponRange ?? 0) > 0) ||
            (u.type === 3 && (u.deployed || (u.attackState ?? 0) >= 3))),
      )
      .filter((u) =>
        contactThreats.some(
          (e) =>
            weaponDistance2(u, e) <=
            (u.deployed
              ? (u.deployedWeaponRange ?? u.weaponRange ?? 0)
              : (u.weaponRange ?? 0)) **
              2,
        ),
      )
      .reduce(
        (n, u) =>
          n +
          antiArmorPower({
            ...u,
            observedTick: o.tick,
            weaponRange: u.deployed
              ? (u.deployedWeaponRange ?? u.weaponRange)
              : u.weaponRange,
          }),
        0,
      );
    const ownPower =
      supportPower + core.reduce((n, u) => n + Math.sqrt(u.hp / u.maxHp), 0);
    const overwhelmed =
      !finishNow && enemyPower > Math.max(1.5, ownPower * (held ? 0.95 : 1.1));
    if (overwhelmed && !held) {
      const contact = [...contactThreats].sort(
        (a, b) => distance2(a, rally) - distance2(b, rally),
      )[0];
      if (contact) {
        const front = [...core].sort(
          (a, b) => distance2(a, contact) - distance2(b, contact),
        )[0];
        this.heldContacts.set(mission.id, {
          point: { x: front.x, y: front.y },
          goal: mission.destination,
        });
      }
    } else if (!overwhelmed) this.heldContacts.delete(mission.id);
    const lagging = tanks.filter((u) => !coreIds.has(u.ref));
    const inContact = core.some((u) =>
      o.enemies.some((e) => !e.airborne && distance2(u, e) <= 8 ** 2),
    );
    if (
      core.length < Math.min(4, Math.ceil(tanks.length * 0.65)) &&
      !inContact &&
      !core.some((u) => u.onBridge)
    ) {
      if (!this.waits.has(mission.id)) this.waits.set(mission.id, o.tick);
    } else this.waits.delete(mission.id);
    const wait = this.waits.get(mission.id);
    const regroup = wait !== undefined && o.tick - wait < 450;
    const dangerous =
      supportedTarget(nearby, core, rally, 14) ??
      nearby.sort((a, b) => distance2(a, rally) - distance2(b, rally))[0];
    const target = finishNow
      ? preferred
      : (dangerous ??
        (preferred && core.some((u) => distance2(u, preferred) <= 8 ** 2)
          ? preferred
          : undefined) ??
        o.enemies
          .filter(
            (e) => !e.airborne && core.some((u) => distance2(u, e) <= 8 ** 2),
          )
          .sort((a, b) => distance2(a, rally) - distance2(b, rally))[0]);
    const proposed: Intent[] = [];
    const issue = (unit: Unit, key: string, intent: Intent, urgent = false) => {
      const old = this.lastOrders.get(unit.ref);
      if (
        !old ||
        (old.key !== key && (urgent || o.tick - old.tick >= 15)) ||
        o.tick - old.tick >= 180
      ) {
        this.lastOrders.set(unit.ref, { key, tick: o.tick });
        proposed.push(intent);
      }
    };
    let retreating = 0,
      rotating = 0;
    for (const u of members) {
      const close = hard.filter(
        (e) => distance2(u, e) <= ((e.weaponRange ?? 5) + 1) ** 2,
      );
      const support = tanks.filter(
        (a) => a.ref !== u.ref && distance2(a, u) <= 6 ** 2,
      ).length;
      let retreat = this.retreats.get(u.ref);
      if (overwhelmed || (close.length >= 2 && support === 0)) {
        const point =
          [...(this.trails.get(u.ref) ?? [])]
            .reverse()
            .find((p) =>
              threats.every(
                (e) => distance2(p, e) > ((e.weaponRange ?? 5) + 4) ** 2,
              ),
            ) ?? o.home;
        retreat = { point, until: o.tick + 90 };
        this.retreats.set(u.ref, retreat);
      } else if (retreat && o.tick >= retreat.until) {
        this.retreats.delete(u.ref);
        retreat = undefined;
      }
      if (retreat) {
        retreating++;
        issue(
          u,
          `retreat:${retreat.point.x}:${retreat.point.y}`,
          { kind: "move", refs: [u.ref], ...retreat.point, task: mission.id },
          true,
        );
        continue;
      }
      const rotation = rotationPost(u, core, o.enemies);
      if (rotation) {
        rotating++;
        issue(u, `rotate:${rotation.x}:${rotation.y}`, {
          kind: "move",
          refs: [u.ref],
          ...rotation,
          task: mission.id,
        });
        continue;
      }
      if (armor(u) && !coreIds.has(u.ref)) {
        const point = core.every((a) => a.onBridge)
          ? mission.destination
          : rally;
        issue(u, `join:${point.x}:${point.y}`, {
          kind: "move",
          refs: [u.ref],
          ...point,
          task: mission.id,
        });
        continue;
      }
      const air = u.antiAir
        ? o.enemies.find((e) => e.airborne && distance2(e, u) <= 14 ** 2)
        : undefined;
      if (air) {
        issue(u, `attack:${air.ref}`, {
          kind: "attack",
          refs: [u.ref],
          target: air.ref,
          task: mission.id,
        });
        continue;
      }
      if (regroup) {
        issue(u, "regroup", { kind: "stop", refs: [u.ref], task: mission.id });
        continue;
      }
      const crush =
        mission.engagement.allowCrush &&
        !(preferred && mission.objective === "exposed-construction") &&
        u.crusher &&
        !hard.some((e) => distance2(e, u) <= 10 ** 2)
          ? o.enemies
              .filter(
                (e) =>
                  e.type === 3 &&
                  !e.airborne &&
                  distance2(e, u) <= 6 ** 2 &&
                  distance2(e, rally) <= 9 ** 2,
              )
              .sort((a, b) => distance2(a, u) - distance2(b, u))[0]
          : undefined;
      if (crush)
        issue(u, `crush:${crush.ref}`, {
          kind: "crush",
          refs: [u.ref],
          target: crush.ref,
          task: mission.id,
        });
      else if (target) {
        const personal = finishNow
          ? target
          : (localArmorTarget(u, o.enemies, dangerous) ?? target);
        issue(u, `attack:${personal.ref}`, {
          kind: "attack",
          refs: [u.ref],
          target: personal.ref,
          task: mission.id,
        });
      } else
        issue(u, `march:${march!.x}:${march!.y}:${Boolean(march!.onBridge)}`, {
          kind: "attackMove",
          refs: [u.ref],
          ...march!,
          task: mission.id,
        });
    }
    const merged = new Map<string, Intent>();
    for (const intent of proposed) {
      if (!("refs" in intent)) continue;
      const { refs, ...command } = intent;
      const key = JSON.stringify(command),
        existing = merged.get(key);
      if (existing && "refs" in existing) existing.refs.push(...refs);
      else merged.set(key, { ...intent, refs: [...refs] });
    }
    const intents = [...merged.values()];
    return {
      origin: {
        id: mission.id,
        revision: mission.revision,
        controller: "tactics",
      },
      intents,
      report: {
        task: { id: mission.id, revision: mission.revision },
        status: regroup ? "waiting" : "active",
        reason: retreating
          ? "recover-supported-position"
          : regroup
            ? "regroup-stragglers"
            : "supported-advance",
        proposedIntents: intents.length,
        facts: {
          assignedUnits: members.length,
          coreTanks: core.length,
          stragglers: lagging.length,
          retreating,
          rotating,
          visibleHardTargets: nearby.length,
          localEnemyPower: enemyPower,
          localOwnPower: ownPower,
          supportingFirePower: supportPower,
          holdingContact: this.heldContacts.has(mission.id),
        },
        executionEvidence: currentEvidence(mission, evidence),
      },
    };
  }
}
