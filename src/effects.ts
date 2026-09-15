import {
  distance2,
  type Intent,
  type Observation,
  type Unit,
} from "./model.js";

export interface PendingEffect {
  id: string;
  tick: number;
  intent: Intent;
  units: Unit[];
  targetHp?: number;
}

export function rememberIntent(
  id: string,
  intent: Intent,
  o: Observation,
): PendingEffect {
  return {
    id,
    tick: o.tick,
    intent,
    units:
      "refs" in intent ? o.own.filter((u) => intent.refs.includes(u.ref)) : [],
    targetHp:
      intent.kind === "attack" || intent.kind === "crush"
        ? o.enemies.find((e) => e.ref === intent.target)?.hp
        : undefined,
  };
}

/** Evidence categories deliberately say less than "the command succeeded". */
export function observedEffect(
  p: PendingEffect,
  o: Observation,
): string | undefined {
  const i = p.intent;
  if (
    i.kind === "queue" &&
    o.queues.some(
      (q) =>
        q.type === i.product.queue &&
        q.items.some((item) => item.name === i.product.name),
    )
  )
    return "queue_item_observed";
  if (
    i.kind === "place" &&
    o.own.some((u) => u.name === i.name && u.x === i.x && u.y === i.y)
  )
    return "building_appeared_at_requested_site";
  if (i.kind === "deploy") {
    if (
      p.units.some(
        (before) =>
          before.mcv && o.own.some((u) => u.yard && distance2(before, u) <= 9),
      )
    )
      return "construction_yard_observed";
    if (
      p.units.some((before) =>
        o.own.some(
          (u) => u.ref === before.ref && u.deployed !== before.deployed,
        ),
      )
    )
      return "deployment_state_changed";
  }
  if (i.kind === "move" || i.kind === "attackMove") {
    if (
      p.units.some((before) =>
        o.own.some((u) => u.ref === before.ref && distance2(u, before) >= 1),
      )
    )
      return "position_changed_not_arrival";
  }
  if ((i.kind === "attack" || i.kind === "crush") && p.targetHp !== undefined) {
    const target = o.enemies.find((e) => e.ref === i.target);
    if (target && target.hp < p.targetHp)
      return "visible_target_hp_decreased_cause_unassigned";
  }
  return undefined;
}
