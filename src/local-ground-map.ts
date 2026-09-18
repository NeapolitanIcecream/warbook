import createGraph from "ngraph.graph";
import { aStar } from "ngraph.path";
import type { MapApi, SpeedType } from "@chronodivide/game-api";
import { distance2, type Point } from "./model.js";

interface GroundPoint extends Point {
  z: number;
}
const key = (p: Point) => `${p.x}:${p.y}`;

/** Planning owns its graph: SDK findPath mutates the live terrain cache and can desync replays. */
export class LocalGroundMap {
  private readonly graph = createGraph<GroundPoint>();
  readonly points: GroundPoint[] = [];

  constructor(
    map: MapApi,
    owner: string,
    home: Point,
    speed: SpeedType,
    radius: number,
  ) {
    for (let x = home.x - radius; x <= home.x + radius; x++)
      for (let y = home.y - radius; y <= home.y + radius; y++) {
        if (distance2({ x, y }, home) > radius ** 2) continue;
        const tile = map.getTile(x, y);
        if (!tile || !map.isVisibleTile(tile, owner)) continue;
        // Local hints stay on ground. Native movement handles complete routes,
        // including bridges; no unseen terrain enters this graph.
        if (
          map.hasBridgeOnTile(tile) ||
          !map.isPassableTile(tile, speed, false, false)
        )
          continue;
        const point = { x, y, z: tile.z };
        this.points.push(point);
        this.graph.addNode(key(point), point);
      }
    for (const p of this.points)
      for (const [dx, dy] of [
        [-1, 0],
        [-1, -1],
        [0, -1],
        [1, -1],
      ]) {
        const other = this.graph.getNode(key({ x: p.x + dx, y: p.y + dy }));
        // Pinned Terrain.connectTiles permits a ground height difference <= 1.
        if (other && Math.abs(p.z - other.data.z) <= 1)
          this.graph.addLink(key(p), other.id);
      }
  }

  reachableFrom(point: Point): GroundPoint[] {
    const start = this.graph.getNode(key(point));
    if (!start) return [];
    const seen = new Set([start.id]),
      pending = [start];
    for (let i = 0; i < pending.length; i++)
      this.graph.forEachLinkedNode(pending[i].id, (node) => {
        if (!seen.has(node.id)) {
          seen.add(node.id);
          pending.push(node);
        }
      });
    return pending.map((n) => n.data);
  }

  path(
    from: Point,
    to: Point,
    excluded: (p: Point) => boolean = () => false,
  ): Point[] {
    if (
      !this.graph.hasNode(key(from)) ||
      !this.graph.hasNode(key(to)) ||
      excluded(from) ||
      excluded(to)
    )
      return [];
    const finder = aStar(this.graph, {
      distance: (a, b) => Math.sqrt(distance2(a.data, b.data)),
      heuristic: (a, b) => Math.sqrt(distance2(a.data, b.data)),
      blocked: (a, b) => excluded(a.data) || excluded(b.data),
    });
    return finder
      .find(key(from), key(to))
      .reverse()
      .map((n) => ({ x: n.data.x, y: n.data.y }));
  }
}
