import {
  distance2,
  weaponDistance2,
  type Contact,
  type Observation,
  type Point,
  type Unit,
} from "../model.js";

/** Allocate only the needed relief force when an ongoing attack has to defend home. */
export class DefenseRelief {
  private selected = new Set<string>();
  private lastContact = -Infinity;
  private point?: Point;
  planningCopy(): DefenseRelief {
    const copy = new DefenseRelief();
    copy.selected = new Set(this.selected);
    copy.lastContact = this.lastContact;
    copy.point = this.point && { ...this.point };
    return copy;
  }

  commitPlan(copy: DefenseRelief): void {
    this.selected = new Set(copy.selected);
    this.lastContact = copy.lastContact;
    this.point = copy.point;
  }

  assign(
    o: Observation,
    vehicles: readonly Unit[],
    infantry: readonly Unit[],
    threats: readonly Contact[],
    point: Point,
    assault: ReadonlySet<string>,
    requested: boolean,
  ): Unit[] {
    if (!requested && !this.selected.size) return [];
    if (!threats.length) {
      if (o.tick - this.lastContact > 150) this.selected.clear();
      return vehicles.filter((u) => this.selected.has(u.ref));
    }
    this.lastContact = o.tick;
    this.point = point;
    const hp = (u: { hp: number; maxHp: number }) => Math.sqrt(u.hp / u.maxHp);
    const enemyPower = threats.reduce(
      (n, e) => n + (e.type === 3 ? 0.2 : e.name === "FV" ? 0.6 : 1) * hp(e),
      0,
    );
    // Count only garrison fire that can reach this fight, not every soldier at home.
    const guards = infantry.filter((u) =>
      threats.some(
        (e) =>
          weaponDistance2(u, e) <=
          (u.deployedWeaponRange ?? u.weaponRange ?? 5) ** 2,
      ),
    );
    const forts = o.own.filter(
      (u) =>
        u.type === 2 &&
        (u.weaponRange ?? 0) > 0 &&
        threats.some((e) => weaponDistance2(u, e) <= (u.weaponRange ?? 0) ** 2),
    );
    let deficit =
      enemyPower * 1.2 -
      guards.reduce((n, u) => n + 0.2 * hp(u), 0) -
      forts.reduce((n, u) => n + 0.45 * hp(u), 0);
    const available = vehicles
      .filter(
        (u) =>
          !assault.has(u.ref) ||
          !o.enemies.some(
            (e) =>
              (e.weaponRange ?? 0) > 0 &&
              weaponDistance2(u, e) <= ((e.weaponRange ?? 5) + 1) ** 2,
          ),
      )
      .sort(
        (a, b) =>
          Math.sqrt(distance2(a, point)) +
          (assault.has(a.ref) ? 8 : 0) -
          (this.selected.has(a.ref) ? 4 : 0) -
          (Math.sqrt(distance2(b, point)) +
            (assault.has(b.ref) ? 8 : 0) -
            (this.selected.has(b.ref) ? 4 : 0)),
      );
    const selected: Unit[] = [];
    for (const u of available) {
      if (deficit <= 0) break;
      selected.push(u);
      deficit -= (u.name === "FV" ? 0.6 : 1) * hp(u);
    }
    this.selected = new Set(selected.map((u) => u.ref));
    return selected;
  }

  get destination() {
    return this.point;
  }
}
