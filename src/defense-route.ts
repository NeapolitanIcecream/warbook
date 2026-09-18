import type { MapApi, SpeedType } from "@chronodivide/game-api";
import { distance2, type Point } from "./model.js";
import { LocalGroundMap } from "./local-ground-map.js";

/** Choose an explored local ground post without touching the engine's shared path cache. */
export function defenseRoute(
  map: MapApi,
  owner: string,
  home: Point,
  towards: Point,
  speed: SpeedType,
  navigation = new LocalGroundMap(map, owner, home, speed, 22),
): Point | undefined {
  const origin = [...navigation.points].sort(
    (a, b) => distance2(a, home) - distance2(b, home),
  )[0];
  if (!origin || distance2(origin, home) > 5 ** 2) return;
  const target = navigation
    .reachableFrom(origin)
    .sort((a, b) => distance2(a, towards) - distance2(b, towards))[0];
  if (!target) return;
  return navigation
    .path(origin, target)
    .find((p) => distance2(p, home) >= 6 ** 2 && distance2(p, home) <= 12 ** 2);
}
