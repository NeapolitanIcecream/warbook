import { distance2, type Contact, type Point, type Unit } from "./model.js";

const footprintDistance = (p: Point, b: Unit) =>
  distance2(p, {
    x: Math.max(b.x, Math.min(p.x, b.x + b.width)),
    y: Math.max(b.y, Math.min(p.y, b.y + b.height)),
  });

/** Rank legal sites by the exposed building approaches their fire can cover.
 * Geometry is a planning estimate, not a claim that these shots will occur. */
export function defenseSite(
  home: Point,
  own: readonly Unit[],
  enemies: readonly Contact[],
  ground: readonly Point[],
  candidates: readonly Point[],
  foundation: { width: number; height: number },
  range: number,
): { point: Point; coverage: number } | undefined {
  const assets = own.filter((u) => u.type === 2 && !(u.weaponRange ?? 0));
  const available = ground.filter(
    (p) =>
      !own.some(
        (b) =>
          b.type === 2 &&
          p.x >= b.x &&
          p.x < b.x + b.width &&
          p.y >= b.y &&
          p.y < b.y + b.height,
      ),
  );
  const guards = own.filter(
    (u) => (u.deployedWeaponRange ?? u.weaponRange ?? 0) > 0 && !u.harvester,
  );
  const threats = enemies.filter(
    (e) =>
      !e.airborne &&
      (e.weaponRange ?? 0) > 0 &&
      assets.some((a) => footprintDistance(e, a) <= 18 ** 2),
  );
  const samples = assets.flatMap((asset) => {
    const center = {
      x: asset.x + asset.width / 2,
      y: asset.y + asset.height / 2,
    };
    const approaches = available.filter((p) => {
      const d = footprintDistance(p, asset);
      return (
        d >= 2 ** 2 &&
        d <= 5 ** 2 &&
        (p.x - center.x) * (center.x - home.x) +
          (p.y - center.y) * (center.y - home.y) >=
          0
      );
    });
    const value =
      asset.refinery || asset.yard || /WEAP|POWR/.test(asset.name) ? 2 : 1;
    return approaches.map((point) => {
      const support = guards
        .filter(
          (u) =>
            distance2(u.position ?? u, point) <=
            (u.deployedWeaponRange ?? u.weaponRange ?? 0) ** 2,
        )
        .reduce(
          (n, u) => n + (u.type === 3 ? 1 : 3) * Math.sqrt(u.hp / u.maxHp),
          0,
        );
      const pressure = threats.length
        ? Math.max(
            ...threats.map((e) => 8 / (2 + Math.sqrt(distance2(e, point)))),
          )
        : 0;
      return {
        point,
        weight: (value * (1 + pressure)) / (approaches.length * (1 + support)),
      };
    });
  });
  const ranked = candidates
    .map((point) => {
      const center = {
        x: point.x + foundation.width / 2,
        y: point.y + foundation.height / 2,
      };
      const coverage =
        samples.reduce(
          (n, s) =>
            n + (distance2(center, s.point) <= range ** 2 ? s.weight : 0),
          0,
        ) +
        threats.reduce(
          (n, e) =>
            n + (distance2(center, e.position ?? e) <= range ** 2 ? 2 : 0),
          0,
        );
      return { point, coverage };
    })
    .sort(
      (a, b) =>
        b.coverage - a.coverage ||
        distance2(a.point, home) - distance2(b.point, home) ||
        a.point.x - b.point.x ||
        a.point.y - b.point.y,
    );
  return ranked[0];
}
