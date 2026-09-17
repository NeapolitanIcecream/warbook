import type { MapApi, PathNode, SpeedType } from "@chronodivide/game-api";
import { distance2, type Point } from "./model.js";

/** Reuse engine paths only between explored endpoints, with unseen nodes excluded. */
export function defenseRoute(
  map: MapApi,
  owner: string,
  home: Point,
  towards: Point,
  speed: SpeedType,
): Point | undefined {
  const point = (node: PathNode) => ({ x: node.tile.rx, y: node.tile.ry });
  const allowed = (node: PathNode) =>
    !!map.getTile(node.tile.rx, node.tile.ry) &&
    distance2(point(node), home) <= 22 ** 2 &&
    map.isVisibleTile(node.tile, owner);
  const candidates: PathNode[] = [];
  for (let x = home.x - 22; x <= home.x + 22; x += 2)
    for (let y = home.y - 22; y <= home.y + 22; y += 2) {
      const tile = map.getTile(x, y);
      const node = tile ? { tile, onBridge: false } : undefined;
      if (
        node &&
        allowed(node) &&
        !map.hasBridgeOnTile(tile!) &&
        map.isPassableTile(tile!, speed, false, false)
      )
        candidates.push(node);
    }
  const origin = [...candidates].sort(
    (a, b) => distance2(point(a), home) - distance2(point(b), home),
  )[0];
  if (!origin || distance2(point(origin), home) > 5 ** 2) return;
  const tried: Point[] = [];
  for (const target of candidates.sort(
    (a, b) => distance2(point(a), towards) - distance2(point(b), towards),
  )) {
    const destination = point(target);
    if (tried.some((p) => distance2(p, destination) < 4 ** 2)) continue;
    tried.push(destination);
    const path = map.findPath(speed, false, origin, target, {
      bestEffort: false,
      maxExpandedNodes: 2048,
      excludeNodes: (node) => !allowed(node),
    });
    if (path.length && path.every(allowed)) {
      const forward = [...path].reverse(); // The pinned API returns target → origin.
      const post = forward.find(
        (node) =>
          !node.onBridge &&
          distance2(point(node), home) >= 6 ** 2 &&
          distance2(point(node), home) <= 12 ** 2,
      );
      if (post) return point(post);
    }
    if (tried.length >= 6) break;
  }
}
