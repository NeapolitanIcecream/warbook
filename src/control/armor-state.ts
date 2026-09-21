import type { Point } from "../model.js";

export type OperationPosture = "advance" | "assemble" | "defend" | "withdraw";
export interface OperationOrder {
  kind: OperationPosture;
  goal: { key: string; point: Point; ref?: string; kind: string };
}
export interface OperationCommitReceipt {
  tick: number;
  source: "policy" | "fixed-rule" | "teacher";
  orderChanged: boolean;
  added: readonly string[];
}

/** The actual armor assignment. A planning copy is never an independently running army. */
export interface ArmorState {
  assault: Set<string>;
  joining: Set<string>;
  withdrawing: Set<string>;
  withdrawalPoint?: Point;
  nextLaunchTick: number;
  launchedArmor: number;
  transition: Record<string, number | string>;
  mineGuards: Set<string>;
  flankRefs: Set<string>;
  flankVia?: Point;
  flankAttempted: boolean;
  heldForWave: Set<string>;
  launchThreats: Set<string>;
  launchTick: number;
  order?: OperationOrder;
  goalCleared: boolean;
  operationId: number;
  operationStartedTick: number;
  orderStartedTick: number;
  goalRevision: number;
  membershipRevision: number;
  stateVersion: number;
  orderCohort: Set<string>;
  lastCommit?: OperationCommitReceipt;
}

export function armorState(): ArmorState {
  return {
    assault: new Set(),
    joining: new Set(),
    withdrawing: new Set(),
    nextLaunchTick: 0,
    launchedArmor: 6,
    transition: {},
    mineGuards: new Set(),
    flankRefs: new Set(),
    flankAttempted: false,
    heldForWave: new Set(),
    launchThreats: new Set(),
    launchTick: -Infinity,
    goalCleared: false,
    operationId: 0,
    operationStartedTick: 0,
    orderStartedTick: 0,
    goalRevision: 0,
    membershipRevision: 0,
    stateVersion: 0,
    orderCohort: new Set(),
  };
}

export function copyArmorState(s: ArmorState): ArmorState {
  return {
    ...s,
    assault: new Set(s.assault),
    joining: new Set(s.joining),
    withdrawing: new Set(s.withdrawing),
    mineGuards: new Set(s.mineGuards),
    flankRefs: new Set(s.flankRefs),
    heldForWave: new Set(s.heldForWave),
    launchThreats: new Set(s.launchThreats),
    orderCohort: new Set(s.orderCohort),
    transition: { ...s.transition },
    withdrawalPoint: s.withdrawalPoint && { ...s.withdrawalPoint },
    flankVia: s.flankVia && { ...s.flankVia },
    order: s.order && {
      ...s.order,
      goal: { ...s.order.goal, point: { ...s.order.goal.point } },
    },
    lastCommit: s.lastCommit && {
      ...s.lastCommit,
      added: [...s.lastCommit.added],
    },
  };
}

export function authorizedArmor(s: ArmorState): ReadonlySet<string> {
  return new Set([...s.assault, ...s.joining, ...s.withdrawing]);
}
