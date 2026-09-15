import {
  distance2,
  type Observation,
  type Intent,
  type Unit,
  type Point,
} from "./model.js";
import { RaidTask } from "./raiding.js";
import { RegroupTask } from "./regrouping.js";

export const POLICY_VERSION = "warbook-0.1.5-dev";
export type PolicyMode =
  | "baseline"
  | "cohesive"
  | "guarded"
  | "pillbox"
  | "sentry"
  | "crush"
  | "tempo"
  | "combined"
  | "raid"
  | "counter"
  | "coordinated"
  | "assembly-only"
  | "formed"
  | "contact-filter";
export const POLICY_MODES: readonly PolicyMode[] = [
  "baseline",
  "cohesive",
  "guarded",
  "pillbox",
  "sentry",
  "crush",
  "tempo",
  "combined",
  "raid",
  "counter",
  "coordinated",
  "assembly-only",
  "formed",
  "contact-filter",
];

/** Synchronous policy. It has no engine handle, world events, native IDs or wall clock. */
export class Commander {
  private lastOrders = new Map<string, { tick: number; key: string }>();
  private lastDeploy = new Map<string, number>();
  private exploredStarts = new Set<number>();
  private lastEnemyPosition?: Point;
  private scoutTarget?: Point;
  private scoutBestDistance = Infinity;
  private scoutProgressTick = 0;
  private postponedScouts = new Map<string, number>();
  private readonly raiding = new RaidTask();
  private counterAttackStarted = false;
  private readonly regrouping = new RegroupTask();
  constructor(readonly mode: PolicyMode = "baseline") {}

  private scout(o: Observation, army: Unit[]): Point | undefined {
    const mobile = army.filter((u) => u.mobile);
    if (!mobile.length) return undefined;
    const points = o.scoutPoints ?? [];
    const key = (p: Point) => `${p.x},${p.y}`;
    if (this.scoutTarget) {
      const target = this.scoutTarget;
      const distance = Math.min(...mobile.map((u) => distance2(u, target)));
      if (distance < this.scoutBestDistance) {
        this.scoutBestDistance = distance;
        this.scoutProgressTick = o.tick;
      }
      if (!points.some((p) => p.x === target.x && p.y === target.y))
        this.scoutTarget = undefined;
      else if (o.tick - this.scoutProgressTick >= 900) {
        this.postponedScouts.set(key(target), o.tick + 3600);
        this.scoutTarget = undefined;
      }
    }
    if (!this.scoutTarget) {
      const center = {
        x: mobile.reduce((s, u) => s + u.x, 0) / mobile.length,
        y: mobile.reduce((s, u) => s + u.y, 0) / mobile.length,
      };
      this.scoutTarget = [...points]
        .filter((p) => (this.postponedScouts.get(key(p)) ?? 0) <= o.tick)
        .sort(
          (a, b) =>
            distance2(a, center) - distance2(b, center) ||
            a.x - b.x ||
            a.y - b.y,
        )[0];
      this.scoutProgressTick = o.tick;
      this.scoutBestDistance = this.scoutTarget
        ? Math.min(...mobile.map((u) => distance2(u, this.scoutTarget!)))
        : Infinity;
    }
    return this.scoutTarget;
  }

  decide(o: Observation): Intent[] {
    const intents: Intent[] = [];
    const count = (name: string) => o.own.filter((u) => u.name === name).length;
    const allied = o.side === 0;
    const earlyArmor = [
      "tempo",
      "combined",
      "raid",
      "counter",
      "coordinated",
      "assembly-only",
      "formed",
      "contact-filter",
    ].includes(this.mode);
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
    else if (
      count(names.refinery) < 2 &&
      (!earlyArmor || count(names.tank) >= 4 || o.tick >= 9000)
    )
      building = names.refinery;
    else if (
      count(names.factory) < 2 &&
      o.credits > 3500 &&
      (!earlyArmor || count(names.tank) >= 4 || o.tick >= 9000)
    )
      building = names.factory;
    queue(building);
    const airContacts = o.enemies.filter((e) => e.airborne).length;
    const needAntiAir =
      airContacts > 0 &&
      o.own.filter((u) => u.antiAir && u.mobile).length <
        Math.min(4, Math.max(2, airContacts));
    queue(
      needAntiAir
        ? allied
          ? "FV"
          : "HTK"
        : o.own.filter((u) => u.harvester).length <
            (earlyArmor && count(names.tank) < 4 && o.tick < 9000 ? 2 : 4)
          ? names.miner
          : names.tank,
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
    const formUp = this.mode === "formed";
    const assemble =
      this.mode === "counter" || this.mode === "assembly-only" || formUp;
    const filterContacts =
      this.mode === "counter" || this.mode === "contact-filter";
    // A newly visible tank can still be leaving the factory. Count a nearby
    // force outside our building footprints, using only the ordinary observation.
    const fieldArmor = formUp && !this.counterAttackStarted
      ? army.filter(
          (u) =>
            u.name === names.tank &&
            !o.own.some(
              (b) =>
                b.type === 2 &&
                u.x >= b.x &&
                u.x < b.x + b.width &&
                u.y >= b.y &&
                u.y < b.y + b.height,
            ),
        )
      : [];
    const openingReady = formUp
      ? fieldArmor.some(
          (center) =>
            fieldArmor.filter((u) => distance2(u, center) <= 36).length >= 4,
        )
      : count(names.tank) >= 4;
    if ((assemble || filterContacts) && (openingReady || o.tick >= 9000))
      this.counterAttackStarted = true;
    const holdingCounter = assemble && !this.counterAttackStarted;
    const filteringContacts = filterContacts && !this.counterAttackStarted;
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
      this.scout(o, army) ??
      o.starts.find((p) => distance2(p, o.home) > 25);
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
    const raid =
      this.mode === "raid"
        ? this.raiding.plan(
            o,
            army,
            [...unexplored].sort(
              (a, b) => distance2(a, o.home) - distance2(b, o.home),
            )[0] ?? this.scout(o, army),
          )
        : undefined;
    const raiders = new Set(raid?.units.map((u) => u.ref));
    if (raid) order(raid.units, raid.key, raid.intent, 180);
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
      const regroup =
        this.mode === "coordinated"
          ? this.regrouping.plan(o, army)
          : new Map<string, Point>();
      // Each squad engages nearby legal contacts. Distant squads keep travelling instead of chasing a shared ID.
      for (const unit of army.filter((u) => !raiders.has(u.ref))) {
        const regroupGoal = regroup.get(unit.ref);
        if (regroupGoal) {
          order(
            [unit],
            `regroup:${regroupGoal.x}:${regroupGoal.y}`,
            { kind: "move", refs: [], ...regroupGoal, task: "regroup-armor" },
            90,
          );
          continue;
        }
        const nearby = [...o.enemies]
          .filter(
            (e) =>
              (!e.airborne || unit.antiAir) &&
              distance2(unit, e) < 196 &&
              (!filteringContacts || distance2(e, o.home) < 144),
          )
          .sort(
            (a, b) =>
              (unit.antiAir
                ? Number(!!b.airborne) - Number(!!a.airborne)
                : 0) || distance2(unit, a) - distance2(unit, b),
          );
        const target = nearby[0];
        if (
          [
            "crush",
            "combined",
            "raid",
            "counter",
            "coordinated",
            "assembly-only",
            "formed",
            "contact-filter",
          ].includes(this.mode) &&
          unit.crusher &&
          target?.type === 3 &&
          !target.airborne &&
          distance2(unit, target) < 100
        ) {
          order(
            [unit],
            "crush:" + target.ref,
            {
              kind: "crush",
              refs: [],
              target: target.ref,
              ...(holdingCounter ? { task: "counter-defense" } : {}),
            },
            60,
          );
          continue;
        }
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
            {
              kind: "attack",
              refs: [],
              target: target.ref,
              ...(holdingCounter ? { task: "counter-defense" } : {}),
            },
            180,
          );
        else {
          const goal = holdingCounter
            ? { x: o.home.x + 4, y: o.home.y + 4 }
            : !unit.antiAir && "airborne" in destination && destination.airborne
              ? (enemies.find((e) => !e.airborne) ?? o.home)
              : destination;
          order(
            [unit],
            "advance:" + goal.x + ":" + goal.y,
            {
              kind: "attackMove",
              refs: [],
              x: goal.x,
              y: goal.y,
              ...(holdingCounter ? { task: "counter-rally" } : {}),
            },
            450,
          );
        }
      }
    }
    return intents;
  }
}
