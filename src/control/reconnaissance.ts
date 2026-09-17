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

const key = (p: Point) => `${p.x}:${p.y}`;
export const isScout = (unit: Unit) => ["ADOG", "DOG"].includes(unit.name);

/** A separate scout keeps checking approaches while the army builds, defends or fights. */
export class Reconnaissance {
  private visited = new Map<string, number>();
  private postponed = new Map<string, number>();
  private goal?: Point;
  private bestDistance = Infinity;
  private progressTick = 0;

  destination(
    o: Observation,
    scouts: readonly Unit[],
    feedback?: ControlReport,
  ): Point | undefined {
    if (!scouts.length) return;
    const unit = scouts[0];
    const points = o.scoutPoints ?? [];
    const avoiding = feedback?.additionalCombat?.some(
      (r) => r.task.id === "recon" && r.reason === "avoid-visible-threat",
    );
    for (const start of o.starts)
      if (o.own.some((u) => distance2(u, start) <= 5 ** 2))
        this.visited.set(key(start), o.tick);
    if (this.goal) {
      const distance = distance2(unit, this.goal);
      if (distance < this.bestDistance) {
        this.bestDistance = distance;
        this.progressTick = o.tick;
      }
      if (distance <= 4 ** 2) {
        this.visited.set(key(this.goal), o.tick);
        this.goal = undefined;
      } else if (avoiding || o.tick - this.progressTick >= 450) {
        this.postponed.set(key(this.goal), o.tick + 1800);
        this.goal = undefined;
      }
    }
    if (avoiding) return;
    if (!this.goal) {
      const starts = o.starts.filter(
        (p) => distance2(p, o.home) > 12 ** 2 && !this.visited.has(key(p)),
      );
      const candidates = [...starts, ...points];
      const threats = o.enemies.filter((e) => (e.weaponRange ?? 0) > 0);
      this.goal = candidates
        .filter(
          (p) =>
            (this.postponed.get(key(p)) ?? 0) <= o.tick &&
            o.tick - (this.visited.get(key(p)) ?? -Infinity) >= 900 &&
            !threats.some(
              (e) => distance2(e, p) <= ((e.weaponRange ?? 5) + 3) ** 2,
            ),
        )
        .sort(
          (a, b) =>
            Number(starts.includes(b)) - Number(starts.includes(a)) ||
            distance2(unit, a) - distance2(unit, b) ||
            a.x - b.x ||
            a.y - b.y,
        )[0];
      // Once explored, periodically revisit known base areas; stale visibility is not fresh intelligence.
      this.goal ??= o.starts
        .filter(
          (p) =>
            distance2(p, o.home) > 12 ** 2 &&
            (this.postponed.get(key(p)) ?? 0) <= o.tick &&
            o.tick - (this.visited.get(key(p)) ?? -Infinity) >= 1800,
        )
        .sort(
          (a, b) =>
            (this.visited.get(key(a)) ?? -Infinity) -
            (this.visited.get(key(b)) ?? -Infinity),
        )[0];
      this.bestDistance = this.goal ? distance2(unit, this.goal) : Infinity;
      this.progressTick = o.tick;
    }
    return this.goal;
  }
}

export class ScoutTactics {
  private safe = new Map<string, Point[]>();
  private retreat = new Map<string, { point: Point; until: number }>();
  private orders = new Map<string, { goal: string; tick: number }>();
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
          distance2(unit, e) <= ((e.weaponRange ?? 5) + 3) ** 2,
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
          this.safe.set(ref, [...trail.slice(-7), { x: unit.x, y: unit.y }]);
      } else avoiding++;
      const goal = retreat?.point ?? mission.destination;
      if (!goal) continue;
      const previous = this.orders.get(ref),
        signature = key(goal);
      if (
        !previous ||
        (signature !== previous.goal && o.tick - previous.tick >= 30) ||
        o.tick - previous.tick >= 300
      ) {
        intents.push({
          kind: "move",
          refs: [ref],
          x: goal.x,
          y: goal.y,
          task: mission.id,
        });
        this.orders.set(ref, { goal: signature, tick: o.tick });
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
        status: mission.units.length ? "active" : "idle",
        reason: avoiding ? "avoid-visible-threat" : "reveal-and-revisit",
        proposedIntents: intents.length,
        facts: { assignedUnits: mission.units.length, avoiding },
        executionEvidence: currentEvidence(mission, evidence),
      },
    };
  }
}
