import {
  distance2,
  type Observation,
  type Point,
  type Unit,
} from "../model.js";
import {
  authorizedArmor,
  type ArmorState,
  type OperationOrder,
} from "./armor-state.js";
import type { OperationAction } from "./operation-provider.js";
import type { Operations } from "./operations.js";
import { rendezvous } from "./formation.js";

export const pointKey = (p: Point) => `${p.x}:${p.y}:${Boolean(p.onBridge)}`;
export function sameOrder(a?: OperationOrder, b?: OperationOrder): boolean {
  return (
    a === b || (!!a && !!b && a.kind === b.kind && a.goal.key === b.goal.key)
  );
}

/** Facts can retire confirmed losses and merge arrivals, never choose a new order. */
export function observeArmor(s: ArmorState, o: Observation): void {
  let lost = false;
  for (const ref of o.ownDepartures ?? []) {
    lost = s.assault.delete(ref) || lost;
    lost = s.joining.delete(ref) || lost;
    lost = s.withdrawing.delete(ref) || lost;
    s.flankRefs.delete(ref);
    s.heldForWave.delete(ref);
  }
  if (lost) {
    s.membershipRevision++;
    s.stateVersion++;
  }
  if (!authorizedArmor(s).size) {
    s.order = undefined;
    s.flankRefs.clear();
    s.flankVia = undefined;
    return;
  }
  if (!s.assault.size && s.joining.size && s.order?.kind === "advance") {
    s.assault = new Set(s.joining);
    s.joining.clear();
  }
  const main = o.own.filter((u) => s.assault.has(u.ref));
  if (main.length && s.order?.kind === "advance") {
    const center = rendezvous(main, true);
    for (const u of o.own)
      if (s.joining.has(u.ref) && distance2(u, center) <= 8 ** 2) {
        s.joining.delete(u.ref);
        s.assault.add(u.ref);
      }
  }
  // Track the same visible object, not a replacement chosen by the old strategy.
  const target =
    s.order?.goal.ref && o.enemies.find((e) => e.ref === s.order!.goal.ref);
  if (target && s.order)
    s.order.goal.point = {
      x: target.x,
      y: target.y,
      onBridge: target.onBridge,
    };
}

/** One transaction changes the purpose of the existing force and adds reserves. */
export function applyOperation(
  s: ArmorState,
  a: OperationAction,
  o: Observation,
  reserve: readonly Unit[],
  source: "policy" | "teacher" = "policy",
): void {
  if (a.expectedStateVersion !== s.stateVersion)
    throw new Error("Stale operation transaction");
  if (a.kind === "keep") {
    if (a.order || a.addRefs.length)
      throw new Error("KEEP must not change orders or membership");
    return;
  }
  const owned = authorizedArmor(s),
    available = new Set(reserve.map((u) => u.ref));
  if (
    new Set(a.addRefs).size !== a.addRefs.length ||
    a.addRefs.some((ref) => owned.has(ref) || !available.has(ref))
  )
    throw new Error("Invalid operation reinforcement");
  const order = a.order ?? s.order;
  if (!order || (!owned.size && !a.addRefs.length))
    throw new Error("Operation needs an order and members");
  const changed = !sameOrder(s.order, order);
  if (!owned.size) {
    s.operationId++;
    s.operationStartedTick = o.tick;
  }
  if (changed) {
    s.order = {
      ...order,
      goal: { ...order.goal, point: { ...order.goal.point } },
    };
    s.orderStartedTick = o.tick;
    s.goalRevision++;
    s.orderCohort = new Set([...owned, ...a.addRefs]);
    s.flankRefs.clear();
    s.flankVia = undefined;
    s.flankAttempted = false;
    const oldMain = new Set(s.assault),
      oldJoining = new Set(s.joining);
    s.assault.clear();
    s.joining.clear();
    s.withdrawing.clear();
    if (order.kind === "advance" && owned.size) {
      for (const ref of owned)
        (oldMain.size && oldJoining.has(ref) ? s.joining : s.assault).add(ref);
      for (const ref of a.addRefs) s.joining.add(ref);
    } else {
      const destination = order.kind === "withdraw" ? s.withdrawing : s.assault;
      for (const ref of [...owned, ...a.addRefs]) destination.add(ref);
    }
  } else {
    const destination =
      order.kind === "withdraw"
        ? s.withdrawing
        : order.kind === "advance"
          ? s.joining
          : s.assault;
    for (const ref of a.addRefs) destination.add(ref);
  }
  s.withdrawalPoint =
    order.kind === "withdraw" ? { ...order.goal.point } : undefined;
  if (a.addRefs.length) s.membershipRevision++;
  s.stateVersion++;
  s.lastCommit = {
    tick: o.tick,
    source,
    orderChanged: changed,
    added: [...a.addRefs],
  };
  s.launchedArmor = authorizedArmor(s).size;
  s.transition = {
    operationTransition: `policy-${order.kind}`,
    operationTransitionTick: o.tick,
  };
}

/** Describe the rule's actual result; mixed missions remain detectably unrepresentable. */
export function legacyOrder(
  s: ArmorState,
  operations: Operations,
): OperationOrder | undefined {
  const active = operations.active;
  const contact =
    active &&
    (operations.contacts.find(
      (e) => e.ref === (active.objectiveRef ?? active.ref),
    ) ??
      operations.contacts.find((e) => pointKey(e) === pointKey(active.point)));
  if ((s.assault.size || s.joining.size) && active)
    return {
      kind: "advance",
      goal: {
        key:
          active.objectiveKey ??
          contact?.ref ??
          active.ref ??
          pointKey(active.point),
        point: { ...active.point },
        ref: active.objectiveRef ?? contact?.ref ?? active.ref,
        kind: contact?.name ?? "search",
      },
    };
  if (s.withdrawing.size && s.withdrawalPoint)
    return {
      kind: "withdraw",
      goal: {
        key: `withdraw:${pointKey(s.withdrawalPoint)}`,
        point: { ...s.withdrawalPoint },
        kind: "anchor",
      },
    };
}

export function syncLegacyOrder(
  s: ArmorState,
  operations: Operations,
  tick: number,
): void {
  const order = legacyOrder(s, operations);
  if (!sameOrder(s.order, order)) {
    s.orderStartedTick = tick;
    s.goalRevision++;
    s.stateVersion++;
    s.orderCohort = new Set(authorizedArmor(s));
  }
  if (!s.order && order) {
    s.operationId++;
    s.operationStartedTick = tick;
  }
  s.order = order;
}

/** Rendering a chosen goal has no risk veto or target-clear fallback. */
export function describeOperation(
  s: ArmorState,
  operations: Operations,
  o: Observation,
) {
  const owned = authorizedArmor(s);
  const units = o.own.filter((u) => owned.has(u.ref));
  if (!s.order || s.order.kind !== "advance" || !units.length) {
    operations.active = undefined;
    operations.decision = {
      operationReason: s.order ? `policy-${s.order.kind}` : "unassigned-force",
    };
    return undefined;
  }
  const goal = s.order.goal;
  const ref = o.enemies.some((e) => e.ref === goal.ref) ? goal.ref : undefined;
  return (operations.active = {
    ...operations.describe(o, units, goal.point, ref),
    objectiveKey: goal.key,
    objectiveRef: goal.ref,
    origin: "experiment",
  });
}

export function operationGroups(s: ArmorState, vehicles: readonly Unit[]) {
  const owned = authorizedArmor(s);
  return {
    assault: vehicles.filter((u) => s.assault.has(u.ref)),
    joiners: vehicles.filter((u) => s.joining.has(u.ref)),
    withdrawing: vehicles.filter((u) => s.withdrawing.has(u.ref)),
    reserve: vehicles.filter(
      (u) => !owned.has(u.ref) && !s.mineGuards.has(u.ref),
    ),
    mineGuards: vehicles.filter(
      (u) => s.mineGuards.has(u.ref) && !owned.has(u.ref),
    ),
  };
}
