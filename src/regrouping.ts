import { distance2, type Observation, type Point, type Unit } from "./model.js";

/** Avoid feeding isolated tanks into a visible concentration of enemy armor. */
export class RegroupTask {
  private commitments = new Map<string, { goal: Point; until: number }>();

  plan(o: Observation, army: Unit[]): Map<string, Point> {
    const tanks = army.filter(
      (u) => u.mobile && ["MTNK", "HTNK"].includes(u.name),
    );
    const hostiles = o.enemies.filter(
      (e) => !e.airborne && ["MTNK", "HTNK"].includes(e.name),
    );
    const alive = new Set(tanks.map((u) => u.ref));
    for (const ref of this.commitments.keys())
      if (!alive.has(ref)) this.commitments.delete(ref);
    const orders = new Map<string, Point>();
    for (const tank of tanks) {
      const enemies = hostiles.filter((e) => distance2(e, tank) < 144);
      const friends = tanks.filter((u) => distance2(u, tank) < 64);
      const assembled = enemies.length > 0 && friends.length >= enemies.length;
      const previous = this.commitments.get(tank.ref);
      if (previous && o.tick < previous.until && !assembled) {
        orders.set(tank.ref, previous.goal);
        continue;
      }
      this.commitments.delete(tank.ref);
      if (enemies.length <= friends.length) continue;
      const support = tanks
        .filter(
          (u) =>
            u.ref !== tank.ref &&
            distance2(u, o.home) < distance2(tank, o.home) &&
            enemies.every((e) => distance2(u, e) >= 81),
        )
        .sort((a, b) => distance2(a, tank) - distance2(b, tank))[0];
      const goal = support ? { x: support.x, y: support.y } : { ...o.home };
      this.commitments.set(tank.ref, { goal, until: o.tick + 90 });
      orders.set(tank.ref, goal);
    }
    return orders;
  }
}
