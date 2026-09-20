import type { Observation, Point, Unit } from "../model.js";
import type { Operation, Operations } from "./operations.js";

export interface LegacyLaunchContext {
  observation: Observation;
  operations: Operations;
  ready: readonly Unit[];
  active: boolean;
  protectNow: boolean;
  nextLaunchTick: number;
  firstForceFunded: boolean;
  hasScouts: boolean;
  searchGoal?: Point;
  launchSize: number;
  armor: string;
  reserve?: readonly Unit[];
  slotFree?: boolean;
}

export interface LaunchProposal {
  operation: Operation;
  units: readonly Unit[];
  origin?: "experiment";
}

export interface LaunchProvider {
  readonly experimental?: boolean;
  readonly record?: unknown;
  choose(c: LegacyLaunchContext): LaunchProposal | undefined;
}

/** Extraction only: preserve the old candidate checks, ordering and side effects. */
export class LegacyLaunchProvider {
  choose(c: LegacyLaunchContext): LaunchProposal | undefined {
    const { observation: o, operations, ready, searchGoal } = c;
    const armor = (u: Unit) => u.name === c.armor || u.name === "SREF";
    const opportunity = !c.active ? operations.consider(o, ready) : undefined;
    const exploration =
      !operations.hasKnownBase &&
      (ready.filter(armor).length >= c.launchSize ||
        (c.firstForceFunded && !c.hasScouts && ready.some(armor))) &&
      searchGoal
        ? {
            point: searchGoal,
            reason: "formed-advance" as const,
            defenders: 0,
            productionArrivals: 0,
            travelSeconds: 0,
          }
        : undefined;
    const operation =
      opportunity?.reason === "local-counterattack"
        ? undefined
        : (opportunity ?? exploration);
    if (!c.active && !c.protectNow && o.tick >= c.nextLaunchTick && operation)
      return { operation, units: ready };
  }
}
