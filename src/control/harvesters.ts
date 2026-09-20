import {
  distance2,
  type Intent,
  type Observation,
  type Point,
  type Unit,
} from "../model.js";
import { NativeOrders } from "./native-orders.js";
import {
  currentEvidence,
  type CombatMission,
  type ControlResult,
  type ExecutionEvidence,
} from "./contracts.js";

function corridorDistance2(p: Point, start: Point, end: Point): number {
  const dx = end.x - start.x,
    dy = end.y - start.y;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - start.x) * dx + (p.y - start.y) * dy) / (dx * dx + dy * dy || 1),
    ),
  );
  return distance2(p, { x: start.x + t * dx, y: start.y + t * dy });
}

/** Fast economic-unit tactics; damage comes from own HP, never hidden attackers. */
export class HarvesterTactics {
  private hp = new Map<string, number>();
  private escaping = new Map<string, { refinery: string; since: number }>();
  private unsafe: { point: Point; until: number }[] = [];
  private readonly orders = new NativeOrders();

  control(
    o: Observation,
    mission: CombatMission,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult {
    const intents: Intent[] = [];
    const danger = (p: Point, padding = 3) =>
      o.enemies.some(
        (e) =>
          e.canThreatenVehicles !== false &&
          (e.weaponRange ?? 0) > 0 &&
          distance2(e, p) <= ((e.weaponRange ?? 5) + padding) ** 2,
      );
    this.unsafe = this.unsafe.filter((p) => o.tick < p.until);
    const refineries = o.own.filter(
      (u) => u.refinery && (u.buildStatus === undefined || u.buildStatus === 1),
    );
    let returning = 0,
      sheltered = 0;
    for (const u of o.own.filter(
      (u) => mission.units.includes(u.ref) && u.harvester,
    )) {
      const hit = u.hp < (this.hp.get(u.ref) ?? u.hp);
      this.hp.set(u.ref, u.hp);
      let escape = this.escaping.get(u.ref);
      const issue = (intent: Intent) => {
        if (this.orders.allow(u, intent, o.tick, 0)) intents.push(intent);
      };
      if (hit) {
        if (!this.unsafe.some((p) => distance2(p.point, u) < 6 ** 2))
          this.unsafe.push({ point: { x: u.x, y: u.y }, until: o.tick + 450 });
        const target = [...refineries].sort(
          (a, b) =>
            Number(danger(a, 5)) - Number(danger(b, 5)) ||
            distance2(a, u) - distance2(b, u),
        )[0];
        if (target && (!escape || escape.refinery !== target.ref)) {
          escape = { refinery: target.ref, since: o.tick };
          this.escaping.set(u.ref, escape);
        }
      }
      if (!escape) continue;
      const refinery = refineries.find((r) => r.ref === escape!.refinery);
      if (!refinery) {
        const next = [...refineries].sort(
          (a, b) => distance2(a, u) - distance2(b, u),
        )[0];
        if (next) {
          escape.refinery = next.ref;
          issue({
            kind: "dock",
            refs: [u.ref],
            target: next.ref,
            task: mission.id,
          });
        } else
          issue({ kind: "move", refs: [u.ref], ...o.home, task: mission.id });
        continue;
      }
      // A completed unload is observable. Preserve docking/teleport tasks until then.
      const nearDock =
        distance2(u, {
          x: refinery.x + refinery.width - 1,
          y: refinery.y + Math.floor(refinery.height / 2),
        }) <=
        2 ** 2;
      if (!nearDock || (u.cargo ?? 0) > 0 || o.tick - escape.since < 30) {
        returning++;
        issue({
          kind: "dock",
          refs: [u.ref],
          target: refinery.ref,
          task: mission.id,
        });
        continue;
      }
      const safe = (o.oreFields ?? []).filter(
        (p) =>
          p.amount > 0 &&
          !danger(p, 5) &&
          !o.enemies.some(
            (e) =>
              e.canThreatenVehicles !== false &&
              (e.weaponRange ?? 0) > 0 &&
              corridorDistance2(e, u, p) <= ((e.weaponRange ?? 5) + 3) ** 2,
          ) &&
          !this.unsafe.some((q) => distance2(q.point, p) <= 8 ** 2),
      );
      const goal = safe.sort((a, b) => distance2(a, u) - distance2(b, u))[0];
      if (goal) {
        issue({
          kind: "gather",
          refs: [u.ref],
          x: goal.x,
          y: goal.y,
          task: mission.id,
        });
        this.escaping.delete(u.ref);
      } else {
        sheltered++;
        issue({ kind: "stop", refs: [u.ref], task: mission.id });
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
        task: mission,
        status: "active",
        reason: returning
          ? "return-threatened-miners"
          : sheltered
            ? "wait-for-safe-ore"
            : "preserve-native-harvesting",
        proposedIntents: intents.length,
        facts: { returning, sheltered },
        executionEvidence: currentEvidence(mission, evidence),
      },
    };
  }
}

/** Cargo gain identifies a working patch. Unloading does not move its screen home. */
export class MiningArea {
  private lastCargo = new Map<string, number>();
  private sites = new Map<string, { point: Point; tick: number }>();
  private selected?: Point;
  private lastActiveTick = -Infinity;
  observe(o: Observation): Point | undefined {
    const miners = o.own.filter((u) => u.harvester);
    for (const u of miners) {
      const cargo = u.cargo;
      if (cargo !== undefined && cargo > (this.lastCargo.get(u.ref) ?? cargo))
        this.sites.set(u.ref, { point: { x: u.x, y: u.y }, tick: o.tick });
      if (cargo !== undefined) this.lastCargo.set(u.ref, cargo);
    }
    const patches: { point: Point; miners: number }[] = [];
    for (const u of miners) {
      const site = this.sites.get(u.ref);
      if (!site || o.tick - site.tick > 900) continue;
      const patch = patches.find(
        (p) => distance2(p.point, site.point) <= 8 ** 2,
      );
      if (patch) patch.miners++;
      else patches.push({ point: site.point, miners: 1 });
    }
    const best = patches.sort(
      (a, b) =>
        b.miners - a.miners ||
        (this.selected
          ? distance2(a.point, this.selected) -
            distance2(b.point, this.selected)
          : distance2(b.point, o.home) - distance2(a.point, o.home)),
    )[0];
    if (!best) {
      if (o.tick - this.lastActiveTick <= 150) return this.selected;
      this.selected = undefined;
      return;
    }
    this.lastActiveTick = o.tick;
    if (!this.selected || distance2(this.selected, best.point) > 6 ** 2)
      this.selected = best.point;
    return this.selected;
  }
}
