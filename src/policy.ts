import {
  distance2,
  type Observation,
  type Intent,
  type Unit,
  type Point,
} from "./model.js";

export const POLICY_VERSION = "warbook-0.1.1";
export type PolicyMode =
  "baseline" | "cohesive" | "guarded" | "pillbox" | "sentry";

/** Synchronous policy. It has no engine handle, world events, native IDs or wall clock. */
export class Commander {
  private lastOrders = new Map<string, { tick: number; key: string }>();
  private lastDeploy = new Map<string, number>();
  private exploredStarts = new Set<number>();
  private lastEnemyPosition?: Point;
  constructor(readonly mode: PolicyMode = "baseline") {}

  decide(o: Observation): Intent[] {
    const intents: Intent[] = [];
    const count = (name: string) => o.own.filter((u) => u.name === name).length;
    const allied = o.own.some((u) => u.name === "AMCV" || u.name === "GACNST");
    const names = allied
      ? {
          power: "GAPOWR",
          refinery: "GAREFN",
          barracks: "GAPILE",
          factory: "GAWEAP",
          tank: "MTNK",
          miner: "CMIN",
          infantry: "E1",
        }
      : {
          power: "NAPOWR",
          refinery: "NAREFN",
          barracks: "NAHAND",
          factory: "NAWEAP",
          tank: "HTNK",
          miner: "HARV",
          infantry: "E2",
        };
    for (const u of o.own.filter((u) => u.mcv)) {
      if (o.tick - (this.lastDeploy.get(u.ref) ?? -90) >= 90) {
        intents.push({ kind: "deploy", refs: [u.ref] });
        this.lastDeploy.set(u.ref, o.tick);
      }
    }
    for (const site of o.buildSites) intents.push({ kind: "place", ...site });

    const queue = (name: string | undefined) => {
      const product = o.products.find((p) => p.name === name);
      if (!product) return;
      const q = o.queues.find((q) => q.type === product.queue);
      if (
        !q ||
        q.size ||
        q.status !== 0 ||
        o.credits < Math.min(product.cost, 250)
      )
        return;
      if (
        !intents.some(
          (i) => i.kind === "queue" && i.product.queue === product.queue,
        )
      )
        intents.push({ kind: "queue", product });
    };
    let building: string | undefined;
    if (
      o.power.isLowPower ||
      (count(names.power) && o.power.total - o.power.drain < 30)
    )
      building = names.power;
    else if (!count(names.power)) building = names.power;
    else if (!count(names.refinery)) building = names.refinery;
    else if (!count(names.barracks)) building = names.barracks;
    else if (!count(names.factory)) building = names.factory;
    else if (count(names.refinery) < 2) building = names.refinery;
    else if (count(names.factory) < 2 && o.credits > 3500)
      building = names.factory;
    queue(building);
    queue(
      o.own.filter((u) => u.harvester).length < 4 ? names.miner : names.tank,
    );
    if (
      o.own.filter((u) => u.type === 3 && u.combat).length < 6 &&
      o.credits > 800
    )
      queue(names.infantry);
    if (["guarded", "pillbox", "sentry"].includes(this.mode)) {
      const infantryThreat = o.enemies.filter(
        (e) => e.type === 3 && distance2(e, o.home) < 1600,
      );
      if (infantryThreat.length >= 3 && count(allied ? "GAPILL" : "NALASR") < 2)
        queue(allied ? "GAPILL" : "NALASR");
    }

    const army = o.own.filter(
      (u) => u.combat && (u.mobile || u.deployed) && !u.harvester && !u.mcv,
    );
    if (!army.length) return intents;
    for (const [i, p] of o.starts.entries()) {
      if (distance2(p, o.home) < 25 || army.some((u) => distance2(u, p) < 36))
        this.exploredStarts.add(i);
    }
    const enemies = [...o.enemies].sort(
      (a, b) => distance2(a, o.home) - distance2(b, o.home),
    );
    const threat = enemies.find(
      (e) => distance2(e, o.home) < 625 && e.type !== 2,
    );
    if (enemies.length) this.lastEnemyPosition = enemies[0];
    else if (
      this.lastEnemyPosition &&
      army.some((u) => distance2(u, this.lastEnemyPosition!) < 36)
    ) {
      // The remembered area was revisited without contact. Resume scouting;
      // this does not assert that the former enemy was killed.
      this.lastEnemyPosition = undefined;
    }
    const unexplored = o.starts
      .map((p, i) => ({ ...p, i }))
      .filter((p) => !this.exploredStarts.has(p.i));
    const destination =
      threat ??
      enemies[0] ??
      this.lastEnemyPosition ??
      unexplored.sort(
        (a, b) => distance2(a, o.home) - distance2(b, o.home),
      )[0] ??
      o.starts[(Math.floor(o.tick / 900) + 1) % o.starts.length];
    if (!destination) return intents;
    const order = (
      units: Unit[],
      key: string,
      intent: Intent,
      repeat = 150,
    ) => {
      const refs = units
        .filter((u) => {
          const prev = this.lastOrders.get(u.ref);
          return (
            !prev ||
            (prev.key !== key && o.tick - prev.tick >= 30) ||
            o.tick - prev.tick >= repeat
          );
        })
        .map((u) => u.ref);
      if (!refs.length || !("refs" in intent)) return;
      for (const ref of refs) this.lastOrders.set(ref, { tick: o.tick, key });
      intents.push({ ...intent, refs });
    };
    if (
      this.mode === "cohesive" &&
      !threat &&
      army.length < 8 &&
      o.tick < 4500
    ) {
      const scout = army.slice(0, 1);
      order(
        scout,
        "scout:" + destination.x + ":" + destination.y,
        { kind: "attackMove", refs: [], x: destination.x, y: destination.y },
        300,
      );
      const rally = { x: o.home.x + 4, y: o.home.y + 4 };
      order(
        army.slice(1),
        "rally",
        { kind: "attackMove", refs: [], ...rally },
        450,
      );
    } else {
      // Each squad engages nearby legal contacts. Distant squads keep travelling instead of chasing a shared ID.
      for (const unit of army) {
        const nearby = [...o.enemies]
          .filter((e) => distance2(unit, e) < 196)
          .sort((a, b) => distance2(unit, a) - distance2(unit, b));
        const target = nearby[0];
        if (
          (this.mode === "guarded" || this.mode === "sentry") &&
          unit.name === "E1"
        ) {
          if (this.mode === "sentry" && unit.deployed) continue;
          if (target && distance2(unit, target) < 64 && !unit.deployed) {
            order([unit], "deploy-infantry", { kind: "deploy", refs: [] }, 90);
            continue;
          }
          if (!target && unit.deployed) {
            order(
              [unit],
              "undeploy-infantry",
              { kind: "deploy", refs: [] },
              90,
            );
            continue;
          }
        }
        if (target)
          order(
            [unit],
            "attack:" + target.ref,
            { kind: "attack", refs: [], target: target.ref },
            180,
          );
        else
          order(
            [unit],
            "advance:" + destination.x + ":" + destination.y,
            {
              kind: "attackMove",
              refs: [],
              x: destination.x,
              y: destination.y,
            },
            450,
          );
      }
    }
    return intents;
  }
}
