import {
  distance2,
  type Observation,
  type Point,
  type Unit,
} from "../model.js";

/** Observed threats and defensive staging; no troop orders, spending or attack decisions. */
export class DefenseSituation {
  private approach?: Point;
  private previousHp = new Map<string, number>();
  private damagedAt = new Map<string, number>();
  private responsePost?: Point;
  private lastResponseTick = Number.NEGATIVE_INFINITY;
  private lastThreatTick = Number.NEGATIVE_INFINITY;
  observe(o: Observation) {
    const threat = o.enemies
      .filter(
        (e) =>
          e.type !== 2 &&
          !e.airborne &&
          ((e.weaponRange ?? 1) > 0 || e.canThreatenBuildings) &&
          (e.canThreatenBuildings !== false ||
            e.canThreatenVehicles !== false) &&
          distance2(e, o.home) < 30 ** 2,
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
      .filter(
        (e) =>
          !e.airborne &&
          e.type !== 2 &&
          ((e.weaponRange ?? 1) > 0 || e.canThreatenBuildings),
      )
      .flatMap((enemy) =>
        assets
          .filter(
            (asset) =>
              (asset.type === 2
                ? enemy.canThreatenBuildings !== false
                : enemy.canThreatenVehicles !== false) &&
              assetDistance(enemy, asset) <= 10 ** 2,
          )
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
    return {
      direction,
      requestedPost,
      post,
      assets,
      incursions,
      vehiclePost,
      protectNow,
      localArmor,
      responding: !!this.responsePost,
      damagedAt: this.damagedAt as ReadonlyMap<string, number>,
    };
  }
}
