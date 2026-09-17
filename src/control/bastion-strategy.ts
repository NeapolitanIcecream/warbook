import {
  distance2,
  type Observation,
  type Point,
  type Unit,
} from "../model.js";
import { OpeningStrategy } from "./strategy.js";
import {
  TaskRevision,
  type CombatMission,
  type StrategicController,
  type StrategicPlan,
  type TacticalAssessment,
} from "./contracts.js";

/** A local defender with persistent counterattack membership and a separate garrison. */
export class BastionStrategy implements StrategicController {
  readonly id: string;
  private readonly opening = new OpeningStrategy();
  private readonly revisions = new Map<string, TaskRevision>();
  private readonly productionRevision = new TaskRevision();
  private assault = new Set<string>();
  private joining = new Set<string>();
  private approach?: Point;
  private previousHp = new Map<string, number>();
  private damagedAt = new Map<string, number>();
  private nextLaunchTick = 0;
  private readonly launchSize = 6;
  private responsePost?: Point;
  private lastResponseTick = Number.NEGATIVE_INFINITY;
  private lastThreatTick = Number.NEGATIVE_INFINITY;
  private sawArmorPressure = false;
  private lastHeavyArmorTick = Number.NEGATIVE_INFINITY;
  private hasLaunched = false;

  constructor(private readonly doctrine: "bastion" | "cohort" = "bastion") {
    this.id =
      doctrine === "bastion" ? "bastion-strategy-v6" : "cohort-strategy-v3";
  }

  assessmentRequest(o: Observation) {
    return this.opening.assessmentRequest(o);
  }

  private mission(
    id: string,
    description: Omit<CombatMission, "id" | "revision">,
  ): CombatMission {
    let revision = this.revisions.get(id);
    if (!revision) this.revisions.set(id, (revision = new TaskRevision()));
    return {
      id,
      revision: revision.update({
        ...description,
        units: [...description.units].sort(),
      }),
      ...description,
    };
  }

  plan(o: Observation, assessment: TacticalAssessment): StrategicPlan {
    const base = this.opening.plan(o, assessment);
    const { unitType: armor, factoryType: factory } = this.assessmentRequest(o);
    const infantry = assessment.army.filter((u) => u.type === 3);
    const vehicles = assessment.army.filter((u) => u.type !== 3);
    const alive = new Set(vehicles.map((u) => u.ref));
    const hadAssault = this.assault.size > 0;
    this.assault = new Set([...this.assault].filter((ref) => alive.has(ref)));
    this.joining = new Set([...this.joining].filter((ref) => alive.has(ref)));
    const threat = o.enemies
      .filter(
        (e) => e.type !== 2 && !e.airborne && distance2(e, o.home) < 30 ** 2,
      )
      .sort((a, b) => distance2(a, o.home) - distance2(b, o.home))[0];
    if (threat) this.approach = { x: threat.x, y: threat.y };
    const direction = this.approach ??
      o.starts
        .filter((p) => distance2(p, o.home) > 25)
        .sort((a, b) => distance2(a, o.home) - distance2(b, o.home))[0] ?? {
        x: o.home.x + 4,
        y: o.home.y + 4,
      };
    const dx = direction.x - o.home.x,
      dy = direction.y - o.home.y,
      length = Math.hypot(dx, dy) || 1;
    const requestedPost = {
      x: Math.round(o.home.x + (6 * dx) / length),
      y: Math.round(o.home.y + (6 * dy) / length),
    };
    const route = o.defenseRoute;
    const post =
      route &&
      distance2(route.towards, direction) === 0 &&
      o.tick - route.observedTick <= 450
        ? route.point
        : requestedPost;
    const assets = o.own.filter((u) => u.type === 2 || u.harvester);
    for (const asset of assets) {
      if (asset.hp < (this.previousHp.get(asset.ref) ?? asset.hp))
        this.damagedAt.set(asset.ref, o.tick);
      this.previousHp.set(asset.ref, asset.hp);
    }
    const assetDistance = (enemy: Point, asset: Unit) =>
      distance2(enemy, {
        x: Math.max(asset.x, Math.min(enemy.x, asset.x + asset.width)),
        y: Math.max(asset.y, Math.min(enemy.y, asset.y + asset.height)),
      });
    const incursions = o.enemies
      .filter((e) => !e.airborne && e.type !== 2)
      .flatMap((enemy) =>
        assets
          .filter((asset) => assetDistance(enemy, asset) <= 10 ** 2)
          .map((asset) => ({
            enemy,
            asset,
            distance: assetDistance(enemy, asset),
          })),
      )
      .sort(
        (a, b) =>
          Number(
            o.tick - (this.damagedAt.get(b.asset.ref) ?? -Infinity) < 150,
          ) -
            Number(
              o.tick - (this.damagedAt.get(a.asset.ref) ?? -Infinity) < 150,
            ) || a.distance - b.distance,
      );
    if (incursions.length) {
      this.lastThreatTick = o.tick;
      if (o.tick - this.lastResponseTick >= 90) {
        const { enemy, asset } = incursions[0];
        this.responsePost = {
          x: Math.round((enemy.x + asset.x + asset.width / 2) / 2),
          y: Math.round((enemy.y + asset.y + asset.height / 2) / 2),
        };
        this.lastResponseTick = o.tick;
      }
    } else if (o.tick - this.lastThreatTick > 300)
      this.responsePost = undefined;
    const vehiclePost = this.responsePost ?? post;
    const protectNow = incursions.some(
      ({ asset }) =>
        asset.type === 2 &&
        o.tick - (this.damagedAt.get(asset.ref) ?? -Infinity) < 150,
    );
    const localArmor = o.enemies.filter(
      (e) =>
        e.type === 7 &&
        !["CMIN", "HARV", "AMCV", "SMCV"].includes(e.name) &&
        (distance2(e, o.home) <= 30 ** 2 ||
          assets.some((a) => distance2(a, e) <= 15 ** 2)),
    );
    if (localArmor.length >= 2) {
      this.sawArmorPressure = true;
      this.lastHeavyArmorTick = o.tick;
    }
    const outsideFactory = (u: Unit) =>
      !o.own.some(
        (b) =>
          b.name === factory &&
          u.x >= b.x &&
          u.x < b.x + b.width &&
          u.y >= b.y &&
          u.y < b.y + b.height,
      );
    const center = (units: readonly Unit[]): Point => ({
      x: Math.round(units.reduce((s, u) => s + u.x, 0) / units.length),
      y: Math.round(units.reduce((s, u) => s + u.y, 0) / units.length),
    });
    let assault = vehicles.filter((u) => this.assault.has(u.ref));
    if (hadAssault && assault.filter((u) => u.name === armor).length <= 2) {
      this.assault.clear();
      this.joining.clear();
      assault = [];
      this.nextLaunchTick = o.tick + 450;
    }
    let reserve = vehicles.filter(
      (u) => !this.assault.has(u.ref) && !this.joining.has(u.ref),
    );
    const ready = reserve.filter(
      (u) => outsideFactory(u) && distance2(u, post) <= 12 ** 2,
    );
    if (
      !this.assault.size &&
      !protectNow &&
      o.tick >= this.nextLaunchTick &&
      ready.filter((u) => u.name === armor).length >=
        (o.tick >= 15000 ||
        (this.sawArmorPressure &&
          localArmor.length <= 1 &&
          o.tick - this.lastHeavyArmorTick >= 90)
          ? 4
          : this.launchSize)
    ) {
      this.assault = new Set(ready.map((u) => u.ref));
      this.hasLaunched = true;
      this.sawArmorPressure = false;
      assault = vehicles.filter((u) => this.assault.has(u.ref));
    }
    if (assault.length) {
      const mergePoint = center(assault);
      for (const u of vehicles.filter((u) => this.joining.has(u.ref)))
        if (distance2(u, mergePoint) <= 8 ** 2) {
          this.joining.delete(u.ref);
          this.assault.add(u.ref);
        }
      reserve = vehicles.filter(
        (u) => !this.assault.has(u.ref) && !this.joining.has(u.ref),
      );
      const nextBatch = reserve.filter(
        (u) => outsideFactory(u) && distance2(u, post) <= 12 ** 2,
      );
      if (
        !this.joining.size &&
        nextBatch.filter((u) => u.name === armor).length >= 4
      )
        this.joining = new Set(nextBatch.map((u) => u.ref));
    }
    assault = vehicles.filter((u) => this.assault.has(u.ref));
    const joiners = vehicles.filter((u) => this.joining.has(u.ref));
    reserve = vehicles.filter(
      (u) => !this.assault.has(u.ref) && !this.joining.has(u.ref),
    );
    const fort = o.side === 0 ? "GAPILL" : "NALASR";
    const refinery = o.side === 0 ? "GAREFN" : "NAREFN";
    const mobilizing = this.doctrine === "cohort" && !this.hasLaunched;
    const economy = {
      ...base.production,
      ...(mobilizing
        ? {
            structures: base.production.structures.map((g) => ({
              ...g,
              count: [refinery, factory].includes(g.product)
                ? Math.min(1, g.count)
                : g.count,
            })),
            vehicles: { ...base.production.vehicles, harvesters: 2 },
          }
        : {}),
      defenseAnchor: requestedPost,
      defenses: [
        {
          product: fort,
          count:
            this.doctrine === "bastion" && o.own.some((u) => u.name === factory)
              ? 1
              : 0,
        },
      ],
    };
    const { revision: _oldRevision, ...productionDescription } = economy;
    const production = {
      ...economy,
      revision: this.productionRevision.update(productionDescription),
    };
    const combat = this.mission("main-force", {
      kind: assault.length && !protectNow ? "advance" : "defend",
      units: (protectNow ? vehicles : assault.length ? assault : reserve).map(
        (u) => u.ref,
      ),
      destination:
        assault.length && !protectNow ? base.combat.destination : vehiclePost,
      groundDestination:
        assault.length && !protectNow
          ? base.combat.groundDestination
          : vehiclePost,
      objective: protectNow
        ? "protect-base"
        : assault.length
          ? base.combat.objective
          : this.responsePost
            ? "protect-economy"
            : "muster-counterattack",
      engagement: { allowCrush: true },
    });
    const additionalCombat = [
      this.mission("base-garrison", {
        kind: "defend",
        units: infantry.map((u) => u.ref),
        destination: vehiclePost,
        objective: "guard-base",
        protectedAssets: assets.map((u) => u.ref).sort(),
        approach: direction,
        engagement: { allowCrush: false },
      }),
    ];
    if (assault.length && !protectNow)
      additionalCombat.push(
        this.mission("reserve-force", {
          kind: "defend",
          units: reserve.map((u) => u.ref),
          destination: vehiclePost,
          objective: this.responsePost
            ? "protect-economy"
            : "muster-reinforcements",
          engagement: { allowCrush: true },
        }),
      );
    if (joiners.length && !protectNow)
      additionalCombat.push(
        this.mission("reinforcements", {
          kind: "advance",
          units: joiners.map((u) => u.ref),
          destination: assault.length ? center(assault) : post,
          objective: "join-main-force",
          engagement: { allowCrush: false },
        }),
      );
    return { tick: o.tick, combat, additionalCombat, production };
  }
}
