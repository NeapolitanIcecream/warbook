import {
  distance2,
  type Observation,
  type Point,
  type Unit,
} from "../model.js";
import type { ArmorState } from "./armor-state.js";
import type { Operations } from "./operations.js";
import type { LaunchProvider } from "./launch-provider.js";
import type { ControlReport } from "./contracts.js";
import { formedUnits, rendezvous } from "./formation.js";

export interface LegacyArmorFrame {
  o: Observation;
  vehicles: readonly Unit[];
  armor: string;
  post: Point;
  musterPost: Point;
  stagingDirection: Point;
  workingField?: Point;
  resourcePost?: Point;
  protectNow: boolean;
  firstForceFunded: boolean;
  hasScouts: boolean;
  searchGoal?: Point;
  launchSize: number;
  hadAssault: boolean;
  threatKeys: readonly string[];
  feedback?: ControlReport;
  outsideFactory: (unit: Unit) => boolean;
  covered: (point: Point) => boolean;
}

/** The original armor rules, operating only on the explicitly supplied planning state. */
export function planLegacyArmor(
  state: ArmorState,
  operations: Operations,
  launch: LaunchProvider,
  context: LegacyArmorFrame,
) {
  const {
    o,
    vehicles,
    armor,
    post,
    musterPost,
    stagingDirection,
    workingField,
    resourcePost,
    protectNow,
    firstForceFunded,
    hasScouts,
    searchGoal,
    launchSize,
    hadAssault,
    threatKeys,
    feedback,
    outsideFactory,
    covered,
  } = context;
  const center = rendezvous;
  const combatArmor = (u: Unit) => u.name === armor || u.name === "SREF";
  if (
    state.withdrawalPoint &&
    covered(state.withdrawalPoint) &&
    o.baseRally &&
    !covered(o.baseRally)
  )
    state.withdrawalPoint = o.baseRally;
  for (const ref of state.withdrawing) {
    const u = vehicles.find((u) => u.ref === ref);
    if (
      !u ||
      (!u.onBridge &&
        state.withdrawalPoint &&
        distance2(u, state.withdrawalPoint) <= 4 ** 2)
    )
      state.withdrawing.delete(ref);
  }
  const beginWithdrawal = () => {
    state.withdrawalPoint = o.baseRally ?? post;
    for (const u of vehicles)
      if (
        (state.assault.has(u.ref) || state.joining.has(u.ref)) &&
        (u.onBridge || distance2(u, state.withdrawalPoint) > 4 ** 2)
      )
        state.withdrawing.add(u.ref);
  };
  const mineGuards = assignMiningGuards(state, context);
  const isReserve = (u: Unit) =>
    !state.mineGuards.has(u.ref) &&
    !state.assault.has(u.ref) &&
    !state.joining.has(u.ref) &&
    !state.withdrawing.has(u.ref);
  let assault = vehicles.filter((u) => state.assault.has(u.ref));
  if (
    hadAssault &&
    assault.filter(combatArmor).length < Math.min(3, state.launchedArmor)
  ) {
    state.transition = {
      operationTransition: "force-depleted",
      operationTransitionTick: o.tick,
    };
    beginWithdrawal();
    state.assault.clear();
    state.joining.clear();
    operations.active = undefined;
    assault = [];
    state.nextLaunchTick = o.tick + 450;
  }
  if (
    operations.active?.reason === "formed-advance" &&
    !operations.hasKnownBase &&
    searchGoal
  )
    operations.active.point = searchGoal;
  let operation = operations.target(o, assault);
  // Clearing one area starts the next search from the army's current position.
  // It is a task completion, not evidence that the expedition was defeated.
  if (assault.length && !operation && searchGoal) {
    state.transition = {
      operationTransition: "area-cleared-continue-search",
      operationTransitionTick: o.tick,
    };
    operation = {
      point: searchGoal,
      reason: "formed-advance",
      defenders: 0,
      productionArrivals: 0,
      travelSeconds: 0,
    };
    operations.active = operation;
  }
  if (assault.length && !operation) {
    beginWithdrawal();
    state.assault.clear();
    state.joining.clear();
    assault = [];
  }
  let reserve = vehicles.filter(isReserve);
  if (!state.assault.size && !state.joining.size) state.heldForWave.clear();
  const ready = formedUnits(
    reserve.filter(
      (u) => outsideFactory(u) && distance2(u, musterPost) <= 12 ** 2,
    ),
    musterPost,
  );
  const alternative =
    o.flankApproach &&
    distance2(o.flankApproach.towards, stagingDirection) <= 10 ** 2
      ? o.flankApproach.point
      : undefined;
  const proposal = launch.choose({
    observation: o,
    operations: operations,
    ready,
    active: !!assault.length,
    protectNow,
    nextLaunchTick: state.nextLaunchTick,
    firstForceFunded: firstForceFunded,
    hasScouts: hasScouts,
    searchGoal,
    launchSize: launchSize,
    armor,
    reserve,
    slotFree: !state.assault.size && !state.joining.size,
  });
  if (proposal) {
    const nextOperation = proposal.operation;
    const committed = proposal.units;
    state.assault = new Set(committed.map((u) => u.ref));
    state.launchedArmor = committed.filter(combatArmor).length;
    if (proposal.origin === "experiment") {
      state.heldForWave = new Set(
        reserve.filter((u) => !state.assault.has(u.ref)).map((u) => u.ref),
      );
      state.launchThreats = new Set(threatKeys);
      state.launchTick = o.tick;
    }
    state.transition = {
      operationTransition: nextOperation.reason,
      operationTransitionTick: o.tick,
    };
    operations.active = nextOperation;
    operation = nextOperation;
    state.flankRefs.clear();
    state.flankVia = undefined;
    state.flankAttempted = false;
    if (
      nextOperation.reason === "formed-pressure" &&
      committed.filter((u) => u.name === armor).length >= 12 &&
      alternative
    ) {
      state.flankAttempted = true;
      operation = operations.active = {
        ...nextOperation,
        reason: "two-front-pressure",
      };
      state.transition = {
        operationTransition: "two-front-pressure",
        operationTransitionTick: o.tick,
      };
      state.flankVia = alternative;
      state.flankRefs = new Set(
        [...committed]
          .sort((a, b) => distance2(a, alternative) - distance2(b, alternative))
          .slice(0, Math.floor(committed.length / 2))
          .map((u) => u.ref),
      );
    }
    assault = vehicles.filter((u) => state.assault.has(u.ref));
  }
  if (assault.length) {
    const mergePoint = center(assault);
    for (const u of vehicles.filter((u) => state.joining.has(u.ref)))
      if (distance2(u, mergePoint) <= 8 ** 2) {
        state.joining.delete(u.ref);
        state.assault.add(u.ref);
      }
    reserve = vehicles.filter(isReserve);
    const nextBatch = formedUnits(
      reserve.filter(
        (u) =>
          !state.heldForWave.has(u.ref) &&
          outsideFactory(u) &&
          distance2(u, musterPost) <= 12 ** 2,
      ),
      musterPost,
    );
    if (
      !state.joining.size &&
      nextBatch.filter((u) => u.name === armor).length >=
        (assault.filter((u) => u.name === armor).length <= 3 ||
        nextBatch.some((u) => u.name === "SREF")
          ? 2
          : 4)
    )
      state.joining = new Set(nextBatch.map((u) => u.ref));
  }
  assault = vehicles.filter((u) => state.assault.has(u.ref));
  const joiners = vehicles.filter((u) => state.joining.has(u.ref));
  reserve = vehicles.filter(isReserve);
  const withdrawing = vehicles.filter((u) => state.withdrawing.has(u.ref));
  if (
    !state.flankAttempted &&
    alternative &&
    assault.filter((u) => u.name === armor).length >= 12 &&
    feedback?.combat.facts.holdingContact
  ) {
    const available = assault
      .filter((u) => u.name === armor && (u.attackState ?? 0) < 3)
      .sort((a, b) => distance2(a, alternative) - distance2(b, alternative));
    if (available.length >= 6) {
      state.flankRefs = new Set(
        available
          .slice(0, Math.min(available.length, Math.floor(assault.length / 2)))
          .map((u) => u.ref),
      );
      state.flankVia = alternative;
      state.flankAttempted = true;
      state.transition = {
        operationTransition: "flank-blocked-contact",
        operationTransitionTick: o.tick,
      };
    }
  }
  return {
    assault,
    joiners,
    withdrawing,
    reserve,
    mineGuards,
    operation,
    alternative,
  };
}

/** Independent guards cannot take members already authorized to the main force. */
export function assignMiningGuards(
  state: ArmorState,
  context: LegacyArmorFrame,
): Unit[] {
  const {
    vehicles,
    armor,
    outsideFactory,
    resourcePost,
    workingField,
    protectNow,
    o,
  } = context;
  const combatArmor = (u: Unit) => u.name === armor || u.name === "SREF";
  const guardCandidates = vehicles.filter(
    (u) =>
      u.name === armor &&
      outsideFactory(u) &&
      !state.assault.has(u.ref) &&
      !state.joining.has(u.ref) &&
      !state.withdrawing.has(u.ref),
  );
  const guardCount =
    resourcePost &&
    workingField &&
    distance2(workingField, o.home) > 12 ** 2 &&
    !protectNow &&
    vehicles.filter(combatArmor).length >= 8
      ? 2
      : 0;
  const mineGuards = guardCandidates
    .sort(
      (a, b) =>
        Number(state.mineGuards.has(b.ref)) -
          Number(state.mineGuards.has(a.ref)) ||
        distance2(a, resourcePost ?? o.home) -
          distance2(b, resourcePost ?? o.home),
    )
    .slice(0, guardCount);
  state.mineGuards = new Set(mineGuards.map((u) => u.ref));
  return mineGuards;
}
