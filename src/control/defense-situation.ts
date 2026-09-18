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
    const route = o.defenseRoute;
    const post =
      route && o.tick - route.observedTick <= 450
        ? route.point
        : (o.baseRally ?? o.home);
    // Mobile miners need vehicle relief. Forward forts are supporting fire,
    // not new anchors that may drag the whole garrison out of the base.
    const assets = o.own.filter((u) => u.harvester || u.type === 2);
    const guardAssets = assets.filter(
      (u) => u.type === 2 && !(u.weaponRange ?? 0),
    );
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
    const contacts = o.enemies
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
              assetDistance(enemy, asset) <= (asset.type === 2 ? 18 : 10) ** 2,
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
    const incursions = contacts.filter((i) => i.distance <= 10 ** 2);
    const guardIncursions = contacts.filter((i) =>
      guardAssets.includes(i.asset),
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
    return {
      direction,
      post,
      assets,
      guardAssets,
      incursions,
      guardIncursions,
      vehiclePost,
      protectNow,
      responding: !!this.responsePost,
      damagedAt: this.damagedAt as ReadonlyMap<string, number>,
    };
  }
}
