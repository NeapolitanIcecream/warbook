import {
  distance2,
  type Contact,
  type Intent,
  type Observation,
  type Point,
  type Unit,
} from "./model.js";

/** A small, persistent squad attacks observed miners while the rest of the army keeps its task. */
export class RaidTask {
  private members = new Set<string>();
  private lastContact?: Contact;
  private retreatUntil = 0;
  private retreatGoal?: Point;

  plan(
    o: Observation,
    army: Unit[],
    scoutPoint?: Point,
  ): { units: Unit[]; key: string; intent: Intent } | undefined {
    const tanks = army.filter(
      (u) => u.mobile && ["MTNK", "HTNK"].includes(u.name),
    );
    this.members = new Set(
      tanks.filter((u) => this.members.has(u.ref)).map((u) => u.ref),
    );
    if (!tanks.length) return undefined;
    const miners = o.enemies.filter(
      (e) => !e.airborne && ["CMIN", "HARV"].includes(e.name),
    );
    const target =
      miners.find((e) => e.ref === this.lastContact?.ref) ??
      miners.sort(
        (a, b) =>
          Math.min(...tanks.map((u) => distance2(u, a))) -
          Math.min(...tanks.map((u) => distance2(u, b))),
      )[0];
    if (target) this.lastContact = { ...target, observedTick: o.tick };
    let contact = this.lastContact;
    if (
      contact &&
      !target &&
      (o.tick - contact.observedTick > 450 ||
        tanks.some(
          (u) => this.members.has(u.ref) && distance2(u, contact!) < 9,
        ))
    ) {
      this.members.clear();
      this.lastContact = undefined;
      contact = undefined;
    }
    const goal = contact ?? scoutPoint;
    if (!goal) return undefined;
    const squadSize = Math.min(2, Math.max(1, Math.floor(tanks.length / 2)));
    this.members = new Set([...this.members].slice(0, squadSize));
    for (const tank of [...tanks].sort(
      (a, b) => distance2(a, goal) - distance2(b, goal),
    )) {
      if (this.members.size >= squadSize) break;
      this.members.add(tank.ref);
    }
    const units = tanks.filter((u) => this.members.has(u.ref));
    if (!units.length) return undefined;
    const guards = o.enemies.filter(
      (e) =>
        !e.airborne &&
        e.type !== 2 &&
        !["CMIN", "HARV"].includes(e.name) &&
        units.some((u) => distance2(u, e) < 100),
    );
    const nearbyFriends = tanks.filter((u) =>
      units.some((r) => distance2(u, r) < 100),
    );
    const armoredGuards = guards.filter((e) => e.type === 7);
    const pressured =
      guards.length > 0 &&
      (units.some((u) => u.hp < u.maxHp * 0.65) ||
        armoredGuards.length > nearbyFriends.length);
    if (pressured) {
      this.retreatUntil = o.tick + 180;
      if (!this.retreatGoal) {
        const support = tanks
          .filter(
            (u) =>
              !this.members.has(u.ref) &&
              guards.every((e) => distance2(u, e) >= 100),
          )
          .sort((a, b) => distance2(a, units[0]) - distance2(b, units[0]))[0];
        this.retreatGoal = support
          ? { x: support.x, y: support.y }
          : { ...o.home };
      }
    }
    if (this.retreatGoal && o.tick < this.retreatUntil)
      return {
        units,
        key: `raid-retreat:${this.retreatGoal.x}:${this.retreatGoal.y}`,
        intent: {
          kind: "move",
          refs: [],
          ...this.retreatGoal,
          task: "raid-retreat",
        },
      };
    this.retreatGoal = undefined;
    return {
      units,
      key: target ? `raid:${target.ref}` : `raid-search:${goal.x}:${goal.y}`,
      intent: target
        ? { kind: "attack", refs: [], target: target.ref, task: "raid-economy" }
        : {
            kind: "move",
            refs: [],
            x: goal.x,
            y: goal.y,
            task: contact ? "raid-search" : "raid-scout",
          },
    };
  }
}
