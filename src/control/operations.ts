import {
  distance2,
  type Contact,
  type Observation,
  type Point,
  type Unit,
} from "../model.js";
import { canFinishNearby } from "./finishing.js";

export interface Operation {
  point: Point;
  ref?: string;
  reason:
    | "exposed-construction"
    | "counterattack-window"
    | "attack-opportunity"
    | "formed-advance"
    | "local-counterattack";
  defenders: number;
  productionArrivals: number;
  travelSeconds: number;
  assumedProduction?: boolean;
}
const mcv = (c: Contact) => ["AMCV", "SMCV"].includes(c.name);
const yard = (c: Contact) => ["GACNST", "NACNST"].includes(c.name);
const factory = (c: Contact) => ["GAWEAP", "NAWEAP"].includes(c.name);
const distance = (a: Point, b: Point) => Math.sqrt(distance2(a, b));

/** Operational estimates from observed contacts, not engine truth or a battle simulator. */
export class Operations {
  private known = new Map<string, Contact>();
  private pressured = false;
  private lastPressureTick = -Infinity;
  private previousPositions = new Map<string, { point: Point; tick: number }>();
  private observedTankSpeed = 0.8;
  private factorySeen = false;
  active?: Operation;
  decision: Record<string, number | string | boolean> = {};
  get hasKnownBase() {
    return [...this.known.values()].some((e) => e.type === 2);
  }

  observe(o: Observation, localThreats: readonly Contact[]) {
    if (o.enemies.some(factory)) this.factorySeen = true;
    for (const u of o.own.filter((u) => ["MTNK", "HTNK"].includes(u.name))) {
      const point = u.position ?? u,
        previous = this.previousPositions.get(u.ref);
      if (previous && o.tick > previous.tick && o.tick - previous.tick <= 150) {
        const speed =
          (distance(point, previous.point) * 15) / (o.tick - previous.tick);
        if (speed <= 1.5)
          this.observedTankSpeed = Math.max(this.observedTankSpeed, speed);
      }
      this.previousPositions.set(u.ref, {
        point: { x: point.x, y: point.y },
        tick: o.tick,
      });
    }
    const visible = new Set(o.enemies.map((e) => e.ref));
    for (const e of o.enemies) this.known.set(e.ref, { ...e });
    for (const [ref, e] of this.known) {
      if (visible.has(ref)) continue;
      // A checked empty location retires a search target, not a claim that an unseen unit died.
      if (
        e.type === 2
          ? o.own.some((u) => distance2(u, e) <= 6 ** 2)
          : o.tick - e.observedTick > 450
      )
        this.known.delete(ref);
    }
    if (localThreats.some((e) => (e.weaponRange ?? 1) > 0)) {
      this.pressured = true;
      this.lastPressureTick = o.tick;
    }
  }

  stagingDirection(o: Observation, fallback: Point): Point {
    const target =
      this.active?.point ??
      [...this.known.values()]
        .filter((e) => e.type === 2 || mcv(e))
        .sort(
          (a, b) =>
            Number(mcv(b) && distance2(b, o.home) < 30 ** 2) -
              Number(mcv(a) && distance2(a, o.home) < 30 ** 2) ||
            distance2(a, o.home) - distance2(b, o.home),
        )[0] ??
      fallback;
    return { x: target.x, y: target.y };
  }

  private opposition(
    o: Observation,
    target: Contact,
    center: Point,
    tanks: number,
  ) {
    const travelSeconds =
      (distance(center, target) / this.observedTankSpeed) * 1.2;
    const horizon = travelSeconds + target.hp / (12 * tanks);
    let defenders = 0;
    for (const e of this.known.values()) {
      if (
        !(e.weaponRange ?? 0) ||
        e.airborne ||
        e.canThreatenVehicles === false
      )
        continue;
      const speed = e.type === 2 ? 0 : e.type === 3 ? 0.45 : 0.8;
      const age = Math.min(30, (o.tick - e.observedTick) / 15);
      const reach = 7 + speed * (horizon + age);
      // An enemy can meet us on the way; it need not return to the objective
      // before our estimated arrival to take part in the battle.
      if (distance(e, target) > reach && distance(e, center) > reach) continue;
      const value =
        e.type === 2
          ? 0.45
          : e.type === 3
            ? e.name === "E1" && e.deployed
              ? 0.37
              : 0.12
            : e.name === "FV"
              ? 0.6
              : 1;
      defenders += value * Math.sqrt(e.hp / e.maxHp);
    }
    // A factory last seen under fog is still a possible source of reinforcements.
    const sources: Point[] = [...this.known.values()].filter(factory);
    const assumedProduction = !sources.length && !this.factorySeen;
    if (assumedProduction) {
      // Working prior: one factory near known economic buildings, otherwise at a
      // possible enemy start. A relocating MCV does not teleport its production.
      const origin =
        [...this.known.values()]
          .filter((e) => e.type === 2 && !yard(e) && !(e.weaponRange ?? 0))
          .sort((a, b) => distance2(a, target) - distance2(b, target))[0] ??
        o.starts
          .filter((p) => distance2(p, o.home) > 12 ** 2)
          .sort((a, b) => distance2(a, target) - distance2(b, target))[0];
      if (origin) sources.push(origin);
    }
    const productionArrivals = sources.reduce(
      (n, f) =>
        n + Math.max(0, Math.floor((horizon - distance(f, target) / 0.8) / 30)),
      0,
    );
    return { defenders, productionArrivals, travelSeconds, assumedProduction };
  }

  consider(o: Observation, force: readonly Unit[]): Operation | undefined {
    const tanks = force.filter((u) => ["MTNK", "HTNK"].includes(u.name));
    this.decision = {
      operationReason: "assembling-force",
      formedTanks: tanks.length,
    };
    if (tanks.length < 2) return;
    const center = {
      x: tanks.reduce((s, u) => s + u.x, 0) / tanks.length,
      y: tanks.reduce((s, u) => s + u.y, 0) / tanks.length,
    };
    const bases = [...this.known.values()].filter((e) => e.type === 2);
    const candidates = o.enemies
      .filter((e) => mcv(e) || e.type === 2)
      .sort(
        (a, b) =>
          Number(mcv(b) || yard(b)) - Number(mcv(a) || yard(a)) ||
          distance2(a, center) - distance2(b, center),
      );
    // Last seen buildings can guide investigation, but cannot be issued an object-target attack.
    for (const e of bases)
      if (!candidates.some((c) => c.ref === e.ref)) candidates.push(e);
    const power = tanks.reduce((sum, u) => sum + Math.sqrt(u.hp / u.maxHp), 0);
    const options: (Operation & { score: number })[] = [];
    this.decision.operationReason = candidates.length
      ? "assessing-defenders"
      : "scouting-for-target";
    let lowestRequired = Infinity;
    for (const target of candidates) {
      const visible = o.enemies.some((e) => e.ref === target.ref);
      const exposed =
        visible &&
        (mcv(target) || yard(target)) &&
        distance(target, o.home) <= 30;
      const estimate = this.opposition(o, target, center, tanks.length);
      const { defenders, productionArrivals, travelSeconds } = estimate;
      const uncertainty = visible ? 0 : 1;
      const required = (defenders + productionArrivals + uncertainty) * 1.2;
      if (required < lowestRequired) {
        lowestRequired = required;
        this.decision = {
          operationReason: "defenders-or-production-risk",
          formedTanks: tanks.length,
          ownPower: power,
          requiredPower: required,
          defenders,
          productionArrivals,
          travelSeconds,
          assumedProduction: estimate.assumedProduction,
        };
      }
      const window = this.pressured && o.tick - this.lastPressureTick <= 1800;
      // A supported two/three-tank opportunity must not wait for an arbitrary
      // fourth tank, especially when late-game income cannot fund it promptly.
      if (power < Math.max(1.5, required)) continue;
      options.push({
        point: { x: target.x, y: target.y },
        ...(visible ? { ref: target.ref } : {}),
        reason: exposed
          ? "exposed-construction"
          : window
            ? "counterattack-window"
            : "attack-opportunity",
        ...estimate,
        score:
          (exposed ? 100 : yard(target) ? 25 : factory(target) ? 20 : 10) -
          travelSeconds / 10 -
          required -
          (visible ? 0 : 30),
      });
    }
    options.sort((a, b) => b.score - a.score);
    if (options[0]) {
      const { score, ...operation } = options[0];
      this.decision = {
        operationReason: operation.reason,
        formedTanks: tanks.length,
        ownPower: power,
        defenders: operation.defenders,
        productionArrivals: operation.productionArrivals,
        travelSeconds: operation.travelSeconds,
        assumedProduction: operation.assumedProduction ?? false,
      };
      return operation;
    }
    // Assess the attacker's reachable support, including units outside the home radius.
    const nearby = o.enemies
      .filter(
        (e) =>
          e.type === 7 &&
          !mcv(e) &&
          (e.weaponRange ?? 0) > 0 &&
          e.canThreatenVehicles !== false &&
          distance(e, o.home) <= 24,
      )
      .sort((a, b) => distance2(a, center) - distance2(b, center));
    if (this.pressured && tanks.length >= 4 && nearby[0]) {
      const estimate = this.opposition(o, nearby[0], center, tanks.length);
      const required = (estimate.defenders + estimate.productionArrivals) * 1.2;
      this.decision = {
        operationReason: "local-support-risk",
        formedTanks: tanks.length,
        ownPower: power,
        requiredPower: required,
        ...estimate,
      };
      if (power >= Math.max(3, required)) {
        this.decision.operationReason = "local-counterattack";
        return {
          point: { x: nearby[0].x, y: nearby[0].y },
          ref: nearby[0].ref,
          reason: "local-counterattack",
          ...estimate,
        };
      }
    }
  }

  target(o: Observation, force: readonly Unit[]): Operation | undefined {
    if (!this.active) return;
    // Exploration serves target discovery. A newly located base or MCV must
    // replace the old search waypoint, even if that waypoint was never reached.
    if (
      this.active.reason === "formed-advance" &&
      (this.hasKnownBase || o.enemies.some(mcv))
    ) {
      this.active = this.consider(o, force);
      if (!this.active) return;
    }
    const visible = o.enemies.find((e) => e.ref === this.active!.ref);
    const remembered = this.active.ref
      ? this.known.get(this.active.ref)
      : undefined;
    const target = visible ?? remembered;
    const tanks = force.filter((u) => ["MTNK", "HTNK"].includes(u.name));
    if (target && tanks.length) {
      const center = {
        x: tanks.reduce((s, u) => s + u.x, 0) / tanks.length,
        y: tanks.reduce((s, u) => s + u.y, 0) / tanks.length,
      };
      const estimate = this.opposition(o, target, center, tanks.length);
      const power = tanks.reduce((s, u) => s + Math.sqrt(u.hp / u.maxHp), 0);
      const finishNow = canFinishNearby(visible, tanks);
      // Re-evaluate during travel and combat. A small commitment margin avoids
      // cancelling a viable fight at exactly the stricter launch threshold.
      if (
        !finishNow &&
        power < (estimate.defenders + estimate.productionArrivals) * 1.05
      ) {
        this.active = this.consider(o, force);
        if (!this.active)
          this.decision.operationReason = "operation-no-longer-supported";
      } else
        this.active = {
          ...this.active,
          point: { x: target.x, y: target.y },
          ...estimate,
        };
    } else if (force.some((u) => distance2(u, this.active!.point) <= 8 ** 2))
      this.active = this.consider(o, force);
    return this.active
      ? {
          ...this.active,
          ref: o.enemies.some((e) => e.ref === this.active!.ref)
            ? this.active.ref
            : undefined,
        }
      : undefined;
  }
}
