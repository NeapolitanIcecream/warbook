import type { MapApi, SpeedType } from "@chronodivide/game-api";
import { distance2, type Point } from "./model.js";
import { LocalGroundMap } from "./local-ground-map.js";

type Footprint = Point & { width: number; height: number };
function availableGround(
  navigation: LocalGroundMap,
  home: Point,
  occupied: readonly Footprint[],
) {
  const origin = [...navigation.points].sort(
    (a, b) => distance2(a, home) - distance2(b, home),
  )[0];
  if (!origin || distance2(origin, home) > 5 ** 2) return [];
  return navigation
    .reachableFrom(origin)
    .filter(
      (p) =>
        !occupied.some(
          (b) =>
            p.x >= b.x &&
            p.x < b.x + b.width &&
            p.y >= b.y &&
            p.y < b.y + b.height,
        ),
    );
}

/** A withdrawal destination belongs near support, independently of the forward defensive line. */
export function baseRally(
  navigation: LocalGroundMap,
  home: Point,
  occupied: readonly Footprint[],
): Point | undefined {
  const p = availableGround(navigation, home, occupied).sort(
    (a, b) => distance2(a, home) - distance2(b, home),
  )[0];
  return p ? { x: p.x, y: p.y } : undefined;
}

/** A reachable forward post, not the first turning point on a route around our own buildings. */
export function defenseRoute(
  map: MapApi,
  owner: string,
  home: Point,
  towards: Point,
  speed: SpeedType,
  navigation = new LocalGroundMap(map, owner, home, speed, 22),
  occupied: readonly Footprint[] = [],
): Point | undefined {
  const dx = towards.x - home.x,
    dy = towards.y - home.y;
  const p = availableGround(navigation, home, occupied)
    .filter(
      (p) =>
        distance2(p, home) <= 10 ** 2 &&
        (p.x - home.x) * dx + (p.y - home.y) * dy > 0,
    )
    .sort(
      (a, b) =>
        distance2(a, towards) - distance2(b, towards) ||
        distance2(a, home) - distance2(b, home),
    )[0];
  return p ? { x: p.x, y: p.y } : undefined;
}
