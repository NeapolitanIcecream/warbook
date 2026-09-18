import {
  distance2,
  weaponDistance2,
  type Contact,
  type Point,
  type Unit,
} from "../model.js";

interface Incursion {
  enemy: Contact;
  asset: Unit;
  distance: number;
}
interface Front {
  id: string;
  contacts: Contact[];
  destination: Point;
  assets: string[];
  urgent: boolean;
  lastSeen: number;
}
export interface GuardAssignment {
  id: string;
  units: string[];
  destination: Point;
  threats: string[];
  protectedAssets: string[];
  urgent: boolean;
  approach: Point;
}

/** Small, game-scoped assignments for visible defense contacts, not a terrain model. */
export class DefenseAssignments {
  private fronts: Front[] = [];
  private owners = new Map<string, string>();
  private nextId = 0;
  private focus?: string;

  assign(
    tick: number,
    infantry: readonly Unit[],
    incursions: readonly Incursion[],
    damagedAt: ReadonlyMap<string, number>,
    support: readonly Unit[] = [],
  ): GuardAssignment[] {
    const remaining = new Map(
      incursions.map(({ enemy }) => [enemy.ref, enemy]),
    );
    const groups: Contact[][] = [];
    // Nearby attackers form one engagement; widely separated approaches remain distinct.
    while (remaining.size) {
      const first = remaining.values().next().value!;
      remaining.delete(first.ref);
      const group = [first];
      for (let i = 0; i < group.length; i++)
        for (const [ref, enemy] of remaining)
          if (distance2(group[i], enemy) <= 8 ** 2) {
            group.push(enemy);
            remaining.delete(ref);
          }
      groups.push(group);
    }
    const used = new Set<string>();
    let fronts = groups.map((contacts): Front => {
      const refs = new Set(contacts.map((e) => e.ref));
      const incidents = incursions.filter(({ enemy }) => refs.has(enemy.ref));
      const { enemy, asset } = incidents[0];
      const destination = {
        x: Math.round((enemy.x + asset.x + asset.width / 2) / 2),
        y: Math.round((enemy.y + asset.y + asset.height / 2) / 2),
      };
      const old = this.fronts
        .filter((f) => !used.has(f.id))
        .sort(
          (a, b) =>
            b.contacts.filter((e) => refs.has(e.ref)).length -
              a.contacts.filter((e) => refs.has(e.ref)).length ||
            distance2(a.destination, destination) -
              distance2(b.destination, destination),
        )
        .find(
          (f) =>
            f.contacts.some((e) => refs.has(e.ref)) ||
            distance2(f.destination, destination) <= 6 ** 2,
        );
      const id = old?.id ?? `base-garrison-${++this.nextId}`;
      used.add(id);
      return {
        id,
        contacts,
        destination,
        assets: [...new Set(incidents.map(({ asset }) => asset.ref))].sort(),
        urgent: incidents.some(
          ({ enemy, asset, distance }) =>
            asset.type === 2 &&
            asset.hp / asset.maxHp <= 0.35 &&
            tick - (damagedAt.get(asset.ref) ?? -Infinity) < 150 &&
            distance <= ((enemy.weaponRange ?? 5) + 1) ** 2,
        ),
        lastSeen: tick,
      };
    });
    // A briefly empty approach remains a useful post between waves. Do not
    // march the whole guard back to one unrelated point after every contact.
    fronts.push(
      ...this.fronts
        .filter(
          (f) =>
            !used.has(f.id) &&
            tick - f.lastSeen <= 900 &&
            (!support.length ||
              f.assets.some((ref) => support.some((u) => u.ref === ref))),
        )
        .map((f) => ({ ...f, contacts: [], urgent: false })),
    );
    const canEngage = (unit: Unit, front: Front) =>
      front.contacts.some(
        (e) =>
          weaponDistance2(unit, e) <=
          (unit.name === "E1"
            ? (unit.deployedWeaponRange ?? 5)
            : (unit.weaponRange ?? 4)) **
            2,
      );
    const weight = (f: Front) => {
      const demand = f.contacts.reduce((n, e) => n + (e.type === 7 ? 3 : 1), 0);
      const covering = support.filter(
        (u) =>
          u.type !== 3 &&
          (u.type === 2 || u.combat) &&
          !u.harvester &&
          (u.weaponRange ?? 0) > 0 &&
          f.contacts.some(
            (e) => weaponDistance2(u, e) <= ((u.weaponRange ?? 5) + 2) ** 2,
          ),
      );
      const relief = covering.reduce(
        (n, u) => n + 3 * Math.sqrt(u.hp / u.maxHp),
        0,
      );
      return Math.max(2, demand - Math.min(demand / 2, relief));
    };
    fronts.sort(
      (a, b) =>
        Number(b.urgent) - Number(a.urgent) ||
        Number(b.contacts.length > 0) - Number(a.contacts.length > 0) ||
        infantry.filter((u) => canEngage(u, b)).length -
          infantry.filter((u) => canEngage(u, a)).length ||
        weight(b) - weight(a) ||
        a.id.localeCompare(b.id),
    );
    // Keep identities for every visible approach, including temporarily unstaffed ones.
    this.fronts = fronts;
    const split =
      fronts.length >= 2 &&
      infantry.length >=
        Math.max(2, weight(fronts[0])) + Math.max(2, weight(fronts[1]));
    if (!split) {
      const committed = fronts.find((f) => f.id === this.focus);
      if (
        committed &&
        (committed.contacts.length || !fronts.some((f) => f.contacts.length)) &&
        !fronts.some((f) => f.urgent)
      )
        fronts = [committed, ...fronts.filter((f) => f !== committed)];
    }
    fronts = fronts.slice(0, split ? 2 : 1);
    this.focus = fronts[0]?.id;
    if (!fronts.length) {
      this.owners.clear();
      return [];
    }
    const desired = new Map<string, number>();
    if (fronts.length === 1) desired.set(fronts[0].id, infantry.length);
    else {
      const demand = fronts.map((f) => weight(f) * (f.urgent ? 2 : 1));
      const first = Math.max(
        2,
        Math.min(
          infantry.length - 2,
          Math.round((infantry.length * demand[0]) / (demand[0] + demand[1])),
        ),
      );
      desired.set(fronts[0].id, first);
      desired.set(fronts[1].id, infantry.length - first);
    }
    const assigned = new Map(fronts.map((f) => [f.id, [] as Unit[]]));
    const free: Unit[] = [];
    for (const unit of infantry) {
      const engaged = fronts
        .filter((f) => canEngage(unit, f))
        .sort(
          (a, b) =>
            Number(b.id === this.owners.get(unit.ref)) -
              Number(a.id === this.owners.get(unit.ref)) ||
            distance2(unit, a.destination) - distance2(unit, b.destination),
        )[0];
      if (engaged) assigned.get(engaged.id)!.push(unit);
      else free.push(unit);
    }
    // Idle troops fill the shortages; retain travel commitments unless another front needs them.
    while (free.length) {
      const front = [...fronts].sort(
        (a, b) =>
          (desired.get(b.id)! - assigned.get(b.id)!.length) /
            desired.get(b.id)! -
          (desired.get(a.id)! - assigned.get(a.id)!.length) /
            desired.get(a.id)!,
      )[0];
      free.sort(
        (a, b) =>
          Math.sqrt(distance2(a, front.destination)) -
          (this.owners.get(a.ref) === front.id ? 4 : 0) -
          (Math.sqrt(distance2(b, front.destination)) -
            (this.owners.get(b.ref) === front.id ? 4 : 0)),
      );
      assigned.get(front.id)!.push(free.shift()!);
    }
    // Critical buildings can draw help even from an ongoing, lower-priority engagement.
    for (const front of fronts.filter((f) => f.urgent)) {
      const defenders = assigned.get(front.id)!;
      for (const other of fronts.filter((f) => !f.urgent)) {
        const donors = assigned.get(other.id)!;
        donors.sort(
          (a, b) =>
            distance2(a, front.destination) - distance2(b, front.destination),
        );
        while (defenders.length < desired.get(front.id)! && donors.length > 2)
          defenders.push(donors.shift()!);
      }
    }
    // One free soldier is not a second squad. Finish the current fight before sending it alone.
    if (fronts.length === 2)
      for (const front of fronts) {
        const units = assigned.get(front.id)!;
        if (
          units.length === 1 &&
          !front.urgent &&
          !canEngage(units[0], front)
        ) {
          const other = fronts.find((f) => f !== front)!;
          assigned.get(other.id)!.push(units.pop()!);
        }
      }
    this.owners.clear();
    return fronts.map((front) => {
      const units = assigned
        .get(front.id)!
        .map((u) => u.ref)
        .sort();
      units.forEach((ref) => this.owners.set(ref, front.id));
      return {
        id: front.id,
        units,
        destination: front.destination,
        threats: front.contacts.map((e) => e.ref).sort(),
        protectedAssets: front.assets,
        urgent: front.urgent,
        approach: {
          x: (front.contacts[0] ?? front.destination).x,
          y: (front.contacts[0] ?? front.destination).y,
        },
      };
    });
  }
}
