import {
  distance2,
  type Observation,
  type Point,
  type Unit,
} from "../model.js";
import {
  TaskRevision,
  type CombatMission,
  type ProductionPlan,
  type StrategicController,
  type StrategicPlan,
  type TacticalAssessment,
} from "./contracts.js";

/** Goals and opening commitments. No unit commands, queue calls or engine handles. */
export class OpeningStrategy implements StrategicController {
  readonly id = "opening-strategy-v1";
  private openingSizeReached = false;
  private attackStarted = false;
  private exploredStarts = new Set<number>();
  private lastEnemyPosition?: Point & { airborne?: boolean; ref?: string };
  private scoutTarget?: Point;
  private scoutBestDistance = Infinity;
  private scoutProgressTick = 0;
  private postponedScouts = new Map<string, number>();
  private combatRevision = new TaskRevision();
  private productionRevision = new TaskRevision();
  assessmentRequest(o: Observation) {
    return o.side === 0
      ? { unitType: "MTNK", factoryType: "GAWEAP" }
      : { unitType: "HTNK", factoryType: "NAWEAP" };
  }

  private scout(o: Observation, army: readonly Unit[]): Point | undefined {
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

  plan(o: Observation, assessment: TacticalAssessment): StrategicPlan {
    const allied = o.side === 0;
    const names = allied
      ? {
          power: "GAPOWR",
          refinery: "GAREFN",
          barracks: "GAPILE",
          factory: "GAWEAP",
          tank: "MTNK",
          miner: "CMIN",
          infantry: "E1",
          antiAir: "FV",
        }
      : {
          power: "NAPOWR",
          refinery: "NAREFN",
          barracks: "NAHAND",
          factory: "NAWEAP",
          tank: "HTNK",
          miner: "HARV",
          infantry: "E2",
          antiAir: "HTK",
        };
    const expansion = assessment.observedArmor >= 4 || o.tick >= 9000;
    const airContacts = o.enemies.filter((e) => e.airborne).length;
    const economy = {
      deploymentUnits: o.own.filter((u) => u.mcv).map((u) => u.ref),
      power: { product: names.power, margin: 30 },
      // First factory precedes a second refinery. Desired counts alone would lose this ordering.
      structures: [
        { product: names.refinery, count: 1 },
        { product: names.barracks, count: 1 },
        { product: names.factory, count: 1 },
        { product: names.refinery, count: expansion ? 2 : 1 },
        {
          product: names.factory,
          count: expansion && o.credits > 3500 ? 2 : 1,
        },
      ],
      vehicles: {
        armor: names.tank,
        harvester: names.miner,
        harvesters: expansion ? 4 : 2,
        antiAir: names.antiAir,
        mobileAntiAir: airContacts ? Math.min(4, Math.max(2, airContacts)) : 0,
      },
      infantry: { product: names.infantry, count: 6 },
      spending: { queueStartFloor: 250, infantryAbove: 800 },
    };
    const production: ProductionPlan = {
      id: "base-production",
      revision: this.productionRevision.update({
        ...economy,
        deploymentUnits: [...economy.deploymentUnits].sort(),
      }),
      ...economy,
    };
    const army = assessment.army;
    let destination: (Point & { airborne?: boolean }) | undefined;
    let groundDestination: Point | undefined;
    let objective = "no-force";
    if (army.length) {
      if (assessment.observedArmor >= 4) this.openingSizeReached = true;
      if (
        (this.openingSizeReached &&
          assessment.armorOutsideFactories > 0 &&
          assessment.armorOutsideFactories === assessment.observedArmor) ||
        o.tick >= 9000
      )
        this.attackStarted = true;
      for (const [i, p] of o.starts.entries())
        if (distance2(p, o.home) < 25 || army.some((u) => distance2(u, p) < 36))
          this.exploredStarts.add(i);
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
      )
        this.lastEnemyPosition = undefined;
      const unexplored = o.starts
        .map((p, i) => ({ ...p, i }))
        .filter((p) => !this.exploredStarts.has(p.i));
      const contact = threat ?? enemies[0];
      const remembered = this.lastEnemyPosition;
      const spawn =
        !contact && !remembered
          ? unexplored.sort(
              (a, b) => distance2(a, o.home) - distance2(b, o.home),
            )[0]
          : undefined;
      const frontier =
        !contact && !remembered && !spawn ? this.scout(o, army) : undefined;
      const raw =
        contact ??
        remembered ??
        spawn ??
        frontier ??
        o.starts.find((p) => distance2(p, o.home) > 25);
      if (raw) {
        objective = contact
          ? `contact:${contact.ref}`
          : remembered
            ? `last:${remembered.ref ?? `${remembered.x},${remembered.y}`}`
            : spawn
              ? `spawn:${spawn.i}`
              : `frontier:${raw.x},${raw.y}`;
        if (!this.attackStarted) {
          destination = groundDestination = {
            x: o.home.x + 4,
            y: o.home.y + 4,
          };
          objective = "opening-rally";
        } else {
          destination = { x: raw.x, y: raw.y };
          const ground =
            "airborne" in raw && raw.airborne
              ? (enemies.find((e) => !e.airborne) ?? o.home)
              : raw;
          groundDestination = { x: ground.x, y: ground.y };
        }
      } else objective = "no-destination";
    }
    const kind = this.attackStarted ? "advance" : "assemble";
    const units = army.map((u) => u.ref);
    const engagement = { contactRadius: 14, crushRadius: 10, allowCrush: true };
    const combat: CombatMission = {
      id: "main-force",
      revision: this.combatRevision.update({
        kind,
        objective,
        units: [...units].sort(),
        engagement,
      }),
      kind,
      units,
      destination,
      groundDestination,
      objective,
      engagement,
    };
    return { tick: o.tick, combat, production };
  }
}
