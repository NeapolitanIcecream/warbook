import { NativeOrders } from "./native-orders.js";
import {
  distance2,
  type Intent,
  type Observation,
  type Point,
  type Unit,
} from "../model.js";
import {
  currentEvidence,
  type CombatMission,
  type ControlReport,
  type ControlResult,
  type ExecutionEvidence,
} from "./contracts.js";

const key = (p: Point) => `${p.x}:${p.y}:${Boolean(p.onBridge)}`;
export const isScout = (unit: Unit) => ["ADOG", "DOG"].includes(unit.name);

/** A separate scout keeps checking approaches while the army builds, defends or fights. */
export class Reconnaissance {
  private visited = new Map<string, number>();
  private bases = new Map<string, Point>();
  private postponed = new Map<string, number>();
  private routes = new Map<
    string,
    { goal?: Point; bestDistance: number; progressTick: number }
  >();

  destination(
    o: Observation,
    scouts: readonly Unit[],
    feedback?: ControlReport,
    missionId = "recon",
  ): Point | undefined {
    if (!scouts.length) return;
    const unit = scouts[0];
    let route = this.routes.get(unit.ref);
    if (!route)
      this.routes.set(
        unit.ref,
        (route = { bestDistance: Infinity, progressTick: o.tick }),
      );
    const points = o.scoutPoints ?? [];
    for (const e of o.enemies)
      if (e.type === 2) this.bases.set(e.ref, { x: e.x, y: e.y });
    const baseDistance = (p: Point) =>
      Math.min(...[...this.bases.values()].map((b) => distance2(p, b)));
    const inspect = (p: Point) => baseDistance(p) <= 20 ** 2;
    const avoiding = feedback?.additionalCombat?.some(
      (r) => r.task.id === missionId && r.reason === "avoid-visible-threat",
    );
    const newlyExplored = (o.exploredStarts ?? []).filter(
      (p) => !this.visited.has(key(p)),
    );
    for (const p of newlyExplored) this.visited.set(key(p), o.tick);
    for (const pending of this.routes.values())
      if (
        pending.goal &&
        newlyExplored.some((p) => key(p) === key(pending.goal!))
      )
        pending.goal = undefined;
    const reserved = [...this.routes]
      .filter(
        ([ref, r]) =>
          ref !== unit.ref && r.goal && o.own.some((u) => u.ref === ref),
      )
      .map(([, r]) => r.goal!);
    const available = (p: Point) =>
      !reserved.some((q) => distance2(p, q) < 12 ** 2);
    for (const start of o.starts)
      if (
        o.exploredStarts === undefined &&
        o.own.some((u) => distance2(u, start) <= 5 ** 2)
      )
        this.visited.set(key(start), o.tick);
    if (route.goal) {
      const distance = distance2(unit, route.goal);
      if (distance < route.bestDistance) {
        route.bestDistance = distance;
        route.progressTick = o.tick;
      }
      const revealed =
        o.scoutPoints !== undefined &&
        !o.starts.some((p) => key(p) === key(route.goal!)) &&
        !points.some((p) => key(p) === key(route.goal!));
      if (
        revealed ||
        (distance <= 4 ** 2 &&
          (o.scoutPoints === undefined ||
            (o.exploredStarts === undefined &&
              o.starts.some((p) => key(p) === key(route.goal!)))))
      ) {
        this.visited.set(key(route.goal), o.tick);
        route.goal = undefined;
      } else if (avoiding || o.tick - route.progressTick >= 450) {
        this.postponed.set(key(route.goal), o.tick + 1800);
        route.goal = undefined;
      }
    }
    if (avoiding) return;
    if (!route.goal) {
      const starts = o.starts.filter(
        (p) => distance2(p, o.home) > 12 ** 2 && !this.visited.has(key(p)),
      );
      const candidates = [...starts, ...points];
      const threats = o.enemies.filter((e) => (e.weaponRange ?? 0) > 0);
      route.goal = candidates
        .filter(
          (p) =>
            available(p) &&
            (this.postponed.get(key(p)) ?? 0) <= o.tick &&
            o.tick - (this.visited.get(key(p)) ?? -Infinity) >= 600 &&
            !threats.some(
              (e) => distance2(e, p) <= ((e.weaponRange ?? 5) + 1.5) ** 2,
            ),
        )
        .sort(
          (a, b) =>
            Number(inspect(b)) - Number(inspect(a)) ||
            Number(starts.includes(b)) - Number(starts.includes(a)) ||
            (inspect(a) && inspect(b)
              ? baseDistance(a) - baseDistance(b)
              : 0) ||
            distance2(unit, a) - distance2(unit, b) ||
            a.x - b.x ||
            a.y - b.y,
        )[0];
      route.bestDistance = route.goal ? distance2(unit, route.goal) : Infinity;
      route.progressTick = o.tick;
    }
    return route.goal;
  }
}

export class ScoutTactics {
  private safe = new Map<string, Point[]>();
  private retreat = new Map<string, { point: Point; until: number }>();
  private readonly orders = new NativeOrders();
  control(
    o: Observation,
    mission: CombatMission,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult {
    const intents: Intent[] = [];
    let avoiding = 0;
    for (const ref of mission.units) {
      const unit = o.own.find((u) => u.ref === ref);
      if (!unit) continue;
      const threats = o.enemies.filter(
        (e) =>
          (e.weaponRange ?? 0) > 0 &&
          distance2(unit, e) <= ((e.weaponRange ?? 5) + 1.5) ** 2,
      );
      let retreat = this.retreat.get(ref);
      if (
        threats.length &&
        (!retreat ||
          threats.some(
            (e) =>
              distance2(e, retreat!.point) <= ((e.weaponRange ?? 5) + 4) ** 2,
          ))
      ) {
        const trail = this.safe.get(ref) ?? [];
        const point = [...trail]
          .reverse()
          .find((p) =>
            threats.every(
              (e) => distance2(e, p) >= ((e.weaponRange ?? 5) + 5) ** 2,
            ),
          );
        retreat = { point: point ?? o.home, until: o.tick + 150 };
        this.retreat.set(ref, retreat);
      }
      if (retreat && !threats.length && o.tick >= retreat.until) {
        this.retreat.delete(ref);
        retreat = undefined;
      }
      if (!retreat) {
        const trail = this.safe.get(ref) ?? [];
        if (!trail.length || distance2(trail[trail.length - 1], unit) >= 4 ** 2)
          this.safe.set(ref, [
            ...trail.slice(-7),
            {
              x: unit.x,
              y: unit.y,
              ...(unit.onBridge === undefined
                ? {}
                : { onBridge: unit.onBridge }),
            },
          ]);
      } else avoiding++;
      const route = o.routes?.find(
        (r) =>
          r.task === mission.id &&
          mission.destination &&
          distance2(r.towards, mission.destination) < 4 ** 2,
      );
      const goal = retreat?.point ?? route?.waypoint ?? mission.destination;
      if (!goal) continue;
      const intent: Intent = {
        kind: "move",
        refs: [ref],
        x: goal.x,
        y: goal.y,
        ...(goal.onBridge ? { onBridge: true } : {}),
        task: mission.id,
      };
      if (this.orders.allow(unit, intent, o.tick)) intents.push(intent);
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
        reason: avoiding ? "avoid-visible-threat" : "reveal-base-and-routes",
        proposedIntents: intents.length,
        facts: { assignedUnits: mission.units.length, avoiding },
        executionEvidence: currentEvidence(mission, evidence),
      },
    };
  }
}
