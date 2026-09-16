import {
  distance2,
  type Intent,
  type Observation,
  type Point,
} from "../model.js";
import { PositionTactics } from "./position-tactics.js";
import {
  currentEvidence,
  type CombatMission,
  type ControlResult,
  type ExecutionEvidence,
} from "./contracts.js";

interface MarchState {
  tick: number;
  key: string;
  regroupSince?: number;
  skipRegroupUntil: number;
}

/** Keep a tank cohort on shared short movement legs, using native opportunity fire. */
export class CohortTactics extends PositionTactics {
  override readonly id = "cohort-movement-v1";
  private marches = new Map<string, MarchState>();
  override control(
    o: Observation,
    mission: CombatMission,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult {
    if (mission.kind !== "advance") {
      this.marches.delete(mission.id);
      return super.control(o, mission, evidence);
    }
    this.prepareMission(mission);
    const assigned = new Set(mission.units);
    const tanks = o.own.filter(
      (u) => assigned.has(u.ref) && ["MTNK", "HTNK"].includes(u.name),
    );
    const tankRefs = new Set(tanks.map((u) => u.ref));
    const support = super.control(
      o,
      { ...mission, units: mission.units.filter((ref) => !tankRefs.has(ref)) },
      evidence,
    );
    const intents: Intent[] = [...support.intents];
    const goal = mission.groundDestination ?? mission.destination;
    let action = "no-tank-destination",
      spread = 0;
    if (tanks.length && goal) {
      const center = {
        x: tanks.reduce((s, u) => s + u.x, 0) / tanks.length,
        y: tanks.reduce((s, u) => s + u.y, 0) / tanks.length,
      };
      spread = Math.max(...tanks.map((u) => Math.sqrt(distance2(u, center))));
      let state = this.marches.get(mission.id);
      if (!state)
        this.marches.set(
          mission.id,
          (state = { tick: -60, key: "", skipRegroupUntil: 0 }),
        );
      const nearby = o.enemies
        .filter((e) => !e.airborne && distance2(e, center) <= 10 ** 2)
        .sort((a, b) => distance2(a, center) - distance2(b, center))[0];
      let destination: Point;
      if (spread > 7 && o.tick >= state.skipRegroupUntil) {
        state.regroupSince ??= o.tick;
        destination = { x: Math.round(center.x), y: Math.round(center.y) };
        action = "regroup-on-route";
        if (o.tick - state.regroupSince >= 450) {
          state.skipRegroupUntil = o.tick + 450;
          state.regroupSince = undefined;
        }
      } else if (nearby) {
        state.regroupSince = undefined;
        const angle =
          Math.atan2(center.y - nearby.y, center.x - nearby.x) + 0.45;
        destination = {
          x: Math.round(nearby.x + 5 * Math.cos(angle)),
          y: Math.round(nearby.y + 5 * Math.sin(angle)),
        };
        action = "maneuver-with-opportunity-fire";
      } else {
        state.regroupSince = undefined;
        const dx = goal.x - center.x,
          dy = goal.y - center.y,
          length = Math.hypot(dx, dy) || 1,
          step = Math.min(6, length);
        destination = {
          x: Math.round(center.x + (step * dx) / length),
          y: Math.round(center.y + (step * dy) / length),
        };
        action = "cohort-march";
      }
      const refs = [...tankRefs].sort();
      const key = JSON.stringify([refs, destination, action]);
      if (
        o.tick - state.tick >= 60 &&
        (key !== state.key || o.tick - state.tick >= 180)
      ) {
        state.tick = o.tick;
        state.key = key;
        intents.push({ kind: "move", refs, ...destination, task: mission.id });
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
        status: tanks.length ? "active" : support.report.status,
        reason: action,
        proposedIntents: intents.length,
        facts: {
          assignedUnits: mission.units.length,
          cohortTanks: tanks.length,
          spread,
          phase: mission.kind,
        },
        executionEvidence: currentEvidence(mission, evidence),
      },
    };
  }
}
