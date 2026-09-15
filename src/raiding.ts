import {
  distance2,
  type Contact,
  type Intent,
  type Observation,
  type Unit,
} from "./model.js";

/** A small, persistent squad attacks observed miners while the rest of the army keeps its task. */
export class RaidTask {
  private members = new Set<string>();
  private lastContact?: Contact;

  plan(
    o: Observation,
    army: Unit[],
  ): { units: Unit[]; key: string; intent: Intent } | undefined {
    const tanks = army.filter(
      (u) => u.mobile && ["MTNK", "HTNK"].includes(u.name),
    );
    this.members = new Set(
      tanks.filter((u) => this.members.has(u.ref)).map((u) => u.ref),
    );
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
    const goal = this.lastContact;
    if (!goal || (!this.members.size && (tanks.length < 4 || !target)))
      return undefined;
    if (
      !target &&
      (o.tick - goal.observedTick > 450 ||
        tanks.some((u) => this.members.has(u.ref) && distance2(u, goal) < 9))
    ) {
      this.members.clear();
      this.lastContact = undefined;
      return undefined;
    }
    for (const tank of [...tanks].sort(
      (a, b) => distance2(a, goal) - distance2(b, goal),
    )) {
      if (this.members.size >= 2) break;
      this.members.add(tank.ref);
    }
    const units = tanks.filter((u) => this.members.has(u.ref));
    if (!units.length) return undefined;
    return {
      units,
      key: target ? `raid:${target.ref}` : `raid-search:${goal.x}:${goal.y}`,
      intent: target
        ? { kind: "attack", refs: [], target: target.ref, task: "raid-economy" }
        : {
            kind: "attackMove",
            refs: [],
            x: goal.x,
            y: goal.y,
            task: "raid-search",
          },
    };
  }
}
