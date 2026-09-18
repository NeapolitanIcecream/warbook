import type { MapApi, SpeedType, PathNode } from "@chronodivide/game-api";
import { distance2, type Point } from "./model.js";

/** Score the known outbound driving path; a Chrono Miner's teleport return is not a walk. */
export function refinerySite(
  map: MapApi,
  owner: string,
  home: Point,
  candidates: readonly Point[],
  foundation: { width: number; height: number },
  speed: SpeedType,
  isLegal: (p: Point) => boolean,
): { point: Point; pathTiles: number; ore: Point } | undefined {
  const ore: (Point & { amount: number })[] = [];
  for (let x = home.x - 35; x <= home.x + 35; x++)
    for (let y = home.y - 35; y <= home.y + 35; y++) {
      const tile = map.getTile(x, y);
      if (!tile || !map.isVisibleTile(tile, owner)) continue;
      const data = map.getTileResourceData(tile);
      const amount = (data?.ore ?? 0) + 2 * (data?.gems ?? 0);
      if (amount) ore.push({ x, y, amount });
    }
  if (!ore.length) return;
  const targets: Point[] = [];
  const ranked = ore
    .map((p) => ({
      ...p,
      density: ore
        .filter((q) => distance2(p, q) <= 4 ** 2)
        .reduce((n, q) => n + q.amount, 0),
    }))
    .sort(
      (a, b) =>
        b.density - a.density || distance2(a, home) - distance2(b, home),
    );
  for (const p of ranked)
    if (p.density >= 12 && !targets.some((q) => distance2(p, q) < 6 ** 2)) {
      targets.push({ x: p.x, y: p.y });
      if (targets.length === 3) break;
    }
  if (!targets.length) return;
  const nearest = (p: Point) =>
    Math.min(...targets.map((q) => distance2(p, q)));
  const legal: Point[] = [];
  for (const p of [...candidates].sort((a, b) => nearest(a) - nearest(b))) {
    if (isLegal(p)) legal.push(p);
    if (legal.length === 12) break;
  }
  let best: { point: Point; pathTiles: number; ore: Point } | undefined;
  for (const p of legal) {
    // Pinned ReturnOreTask.findRefineryDockingTile: rightmost column, middle row.
    const dock = {
      x: p.x + foundation.width - 1,
      y: p.y + Math.floor(foundation.height / 2),
    };
    const tile = map.getTile(dock.x, dock.y);
    if (!tile || !map.isVisibleTile(tile, owner) || map.hasBridgeOnTile(tile))
      continue;
    for (const target of targets) {
      const destination = map.getTile(target.x, target.y)!;
      const allowed = (node: PathNode) =>
        map.isVisibleTile(node.tile, owner) &&
        (!(
          node.tile.rx >= p.x &&
          node.tile.rx < p.x + foundation.width &&
          node.tile.ry >= p.y &&
          node.tile.ry < p.y + foundation.height
        ) ||
          (node.tile.rx === dock.x && node.tile.ry === dock.y));
      const path = map.findPath(
        speed,
        false,
        { tile, onBridge: false },
        { tile: destination, onBridge: false },
        {
          bestEffort: false,
          maxExpandedNodes: 2048,
          excludeNodes: (n) => !allowed(n),
        },
      );
      if (!path.length || !path.every(allowed)) continue;
      const pathTiles = path
        .slice(1)
        .reduce(
          (sum, node, i) =>
            sum +
            Math.hypot(
              node.tile.rx - path[i].tile.rx,
              node.tile.ry - path[i].tile.ry,
            ),
          0,
        );
      if (!best || pathTiles < best.pathTiles)
        best = { point: p, pathTiles, ore: target };
    }
  }
  return best;
}
