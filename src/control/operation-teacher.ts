import { distance2, type Unit } from "../model.js";
import { authorizedArmor } from "./armor-state.js";
import type { OperationContext } from "./operation-provider.js";
import { sameOrder } from "./operation-state.js";
import { formedUnits, rendezvous } from "./formation.js";
import type { OperationSnapshot } from "../learning/operation.js";

/** Versioned teacher that chooses the actual menu, including its exact members.
 * Persistent membership replaces legacy release; partial recall becomes whole-force
 * defense. These are explicit policy changes, not an exact encoding of legacy rules.
 */
export function chooseMenuTeacher(
  c: OperationContext,
  menu: OperationSnapshot,
) {
  const { observation: o, state: s, frame: f } = c;
  const owned = authorizedArmor(s);
  const force = o.own.filter((u) => owned.has(u.ref));
  const reserve = new Map(c.reserve.map((u) => [u.ref, u]));
  const armor = (u: Unit) => [f.armor, "SREF"].includes(u.name);
  const result = (action: number, reason: string) => ({
    action,
    reason: `menu-v1:${reason}`,
  });
  const offers = menu.actions
    .map((a, index) => ({
      a,
      index,
      order: a.order ?? s.order,
      added: a.addRefs.map((ref) => reserve.get(ref)!).filter(Boolean),
    }))
    .filter((x) => x.a.kind === "apply");
  const maneuver = (kind: "assemble" | "defend" | "withdraw", add: boolean) => {
    const anchor = c.anchors[kind][0];
    return offers
      .filter((x) => x.order?.kind === kind && (add || !x.added.length))
      .filter(
        (x) =>
          s.order?.kind !== kind ||
          f.covered(s.order.goal.point) ||
          (sameOrder(s.order, x.order) && x.added.length > 0) ||
          (anchor &&
            distance2(s.order.goal.point, anchor) > 6 ** 2 &&
            distance2(x.order!.goal.point, anchor) <
              distance2(s.order.goal.point, anchor)),
      )
      .sort(
        (a, b) =>
          (anchor
            ? distance2(a.order!.goal.point, anchor) -
              distance2(b.order!.goal.point, anchor)
            : 0) ||
          Number(!sameOrder(s.order, a.order)) -
            Number(!sameOrder(s.order, b.order)) ||
          (add
            ? b.added.length - a.added.length
            : a.added.length - b.added.length),
      )[0];
  };
  // The persistent force may be temporarily absent from legal observations.
  if (owned.size && !force.length) return result(0, "await-own-observation");
  const recalled = c.advice.recalled.some((ref) => owned.has(ref));
  if (f.protectNow || recalled) {
    if (
      s.order?.kind === "defend" &&
      (!c.anchors.defend[0] ||
        distance2(s.order.goal.point, c.anchors.defend[0]) <= 6 ** 2)
    )
      return result(0, "continue-defense");
    const defend = maneuver("defend", true);
    return result(defend?.index ?? 0, "whole-force-defense");
  }
  if (s.order?.kind === "advance") {
    if (force.filter(armor).length < Math.min(3, s.orderCohort.size)) {
      const withdraw = maneuver("withdraw", false);
      return result(withdraw?.index ?? 0, "depleted-withdraw");
    }
    if (menu.operation.cleared) {
      const center = rendezvous(force, true);
      const next = offers
        .filter(
          (x) =>
            !x.added.length &&
            x.order?.kind === "advance" &&
            !sameOrder(x.order, s.order) &&
            (!x.order.goal.ref ||
              c.operations.contacts.some((e) => e.ref === x.order!.goal.ref)),
        )
        .sort(
          (a, b) =>
            distance2(a.order!.goal.point, center) -
            distance2(b.order!.goal.point, center),
        )[0];
      if (next) return result(next.index, "cleared-next-objective");
      return result(maneuver("withdraw", false)?.index ?? 0, "cleared-return");
    }
    // Continue the mission and use the old formed reinforcement thresholds.
    if (!s.joining.size) {
      const threshold = force.filter(armor).length <= 3 ? 2 : 4;
      const reinforcement = offers
        .filter(
          (x) =>
            !x.a.order &&
            x.added.length &&
            x.added.filter(armor).length >=
              (x.added.some((u) => u.name === "SREF") ? 2 : threshold) &&
            x.added.every(
              (u) =>
                f.outsideFactory(u) && distance2(u, f.musterPost) <= 12 ** 2,
            ) &&
            formedUnits(x.added, f.musterPost).length === x.added.length,
        )
        .sort((a, b) => b.added.length - a.added.length)[0];
      if (reinforcement)
        return result(reinforcement.index, "formed-reinforcement");
    }
    return result(0, "continue-advance");
  }
  if (s.order?.kind === "withdraw") {
    if (f.covered(s.order.goal.point))
      return result(
        maneuver("withdraw", false)?.index ?? 0,
        "withdraw-anchor-blocked",
      );
    const arrived = force.every(
      (u) => !u.onBridge && distance2(u, s.order!.goal.point) <= 4 ** 2,
    );
    if (!arrived) return result(0, "continue-withdraw");
    if (o.tick - s.orderStartedTick < 450) return result(0, "arrived-recovery");
  }
  // Unlike the old empty-slot gate, arrived/assembled/defending members are part
  // of the next actual force. Evaluate each offered group and goal on its own merits.
  const attacks: { index: number; score: number }[] = [];
  for (const x of offers) {
    if (x.order?.kind !== "advance") continue;
    const group = [...force, ...x.added];
    if (
      !group.length ||
      !group.every(
        (u) => f.outsideFactory(u) && distance2(u, f.musterPost) <= 12 ** 2,
      ) ||
      formedUnits(group, f.musterPost).length !== group.length
    )
      continue;
    const goal = x.order.goal;
    if (goal.ref) {
      const proposal = c.operations.planningCopy().consider(o, group, goal.ref);
      if (
        !proposal ||
        proposal.reason === "local-counterattack" ||
        distance2(proposal.point, goal.point) > 1
      )
        continue;
      attacks.push({
        index: x.index,
        score:
          (proposal.reason === "exposed-construction" ? 100 : 0) +
          (goal.kind.endsWith("CNST")
            ? 25
            : goal.kind.endsWith("WEAP")
              ? 20
              : 10) -
          proposal.travelSeconds / 10 -
          proposal.defenders * 1.2 -
          proposal.productionArrivals * 1.2 +
          group.length / 100,
      });
    } else if (
      !c.operations.hasKnownBase &&
      (group.filter(armor).length >= f.launchSize ||
        (f.firstForceFunded && !f.hasScouts && group.some(armor)))
    ) {
      attacks.push({
        index: x.index,
        score:
          -Math.sqrt(distance2(rendezvous(group, true), goal.point)) / 10 +
          group.length / 100,
      });
    }
  }
  attacks.sort((a, b) => b.score - a.score);
  if (attacks[0])
    return result(
      attacks[0].index,
      owned.size ? "relaunch-owned-force" : "launch-formed-force",
    );
  // An explicit assembly order preserves the cohort while it receives new tanks.
  const assemble = maneuver("assemble", true);
  if (assemble && (owned.size || assemble.added.length >= 2))
    return result(assemble.index, "assemble-and-reinforce");
  return result(0, "await-formed-opportunity");
}
