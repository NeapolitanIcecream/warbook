import createGraph from "ngraph.graph";
import { aStar } from "ngraph.path";
import {
  ObjectType,
  type GameApi,
  type MapApi,
  type SpeedType,
} from "@chronodivide/game-api";
import { distance2, type Point, type StrategicRegion } from "./model.js";

export interface MapCell extends Point {
  z: number;
  bridge: boolean;
  passable?: boolean;
}
const key = (p: Point & { bridge?: boolean }) =>
  `${p.x}:${p.y}:${(p.bridge ?? p.onBridge) ? 1 : 0}`;

/** Static terrain at tick zero, then only explored passability updates. The pinned
 * getPassableSpeed query ignores mobile units and does not touch engine path caches. */
export class MapPrior {
  private graph = createGraph<MapCell>();
  private openPoints: MapCell[] = [];
  private regions = new Map<string | number, number>();
  get points(): readonly MapCell[] {
    return this.openPoints;
  }
  constructor(
    private cells: MapCell[],
    private speed: SpeedType = 1,
    private subCell = false,
  ) {
    this.rebuild();
  }
  private rebuild() {
    this.graph = createGraph<MapCell>();
    this.openPoints = this.cells.filter((p) => p.passable !== false);
    for (const p of this.openPoints) this.graph.addNode(key(p), p);
    for (const p of this.openPoints)
      for (const [dx, dy] of [
        [-1, 0],
        [-1, -1],
        [0, -1],
        [1, -1],
      ]) {
        for (const onBridge of [false, true]) {
          const q = this.graph.getNode(
            key({ x: p.x + dx, y: p.y + dy, onBridge }),
          );
          if (
            q &&
            Math.abs(p.z - q.data.z) <= (p.bridge || q.data.bridge ? 0 : 1)
          )
            this.graph.addLink(key(p), q.id);
        }
      }
    this.regions.clear();
    let region = 0;
    this.graph.forEachNode((node) => {
      if (this.regions.has(node.id)) return;
      const id = region++,
        pending = [node.id];
      this.regions.set(node.id, id);
      for (let i = 0; i < pending.length; i++)
        this.graph.forEachLinkedNode(pending[i], (next) => {
          if (!this.regions.has(next.id)) {
            this.regions.set(next.id, id);
            pending.push(next.id);
          }
        });
    });
  }
  region(point: Point): number | undefined {
    const node = this.closest(point);
    return node ? this.regions.get(key(node)) : undefined;
  }
  /** Regional edges are contracted from the real independent terrain graph. */
  regionalObservation(
    map: MapApi,
    owner: string,
    vehicle: boolean,
  ): { nodes: StrategicRegion[]; edges: [number, number][] } {
    const groups = new Map<string, number>(),
      membership = new Map<string | number, number>();
    const points: MapCell[][] = [],
      visible: number[] = [],
      components: string[] = [];
    for (const p of this.openPoints) {
      const component = `${vehicle ? "v" : "f"}:${this.regions.get(key(p))}`;
      const groupKey = `${Math.floor(p.x / 8)}:${Math.floor(p.y / 8)}:${p.bridge}:${component}`;
      let index = groups.get(groupKey);
      if (index === undefined) {
        index = points.length;
        groups.set(groupKey, index);
        points.push([]);
        visible.push(0);
        components.push(component);
      }
      points[index].push(p);
      membership.set(key(p), index);
      const tile = map.getTile(p.x, p.y);
      if (tile && map.isVisibleTile(tile, owner, Math.max(0, p.z - tile.z)))
        visible[index]++;
    }
    const nodes = points.map((ps, i) => {
      const center = {
        x: Math.floor(ps[0].x / 8) * 8 + 4,
        y: Math.floor(ps[0].y / 8) * 8 + 4,
      };
      const p = [...ps].sort(
        (a, b) =>
          distance2(a, center) - distance2(b, center) || a.x - b.x || a.y - b.y,
      )[0];
      return {
        x: p.x,
        y: p.y,
        onBridge: p.bridge,
        height: p.z,
        explored: visible[i] / ps.length,
        cells: ps.length,
        vehicle,
        infantry: !vehicle,
        component: components[i],
      };
    });
    const seen = new Set<string>(),
      edges: [number, number][] = [];
    this.graph.forEachLink((link) => {
      const a = membership.get(link.fromId)!,
        b = membership.get(link.toId)!;
      if (a === b) return;
      for (const [from, to] of [
        [a, b],
        [b, a],
      ])
        if (!seen.has(`${from}:${to}`)) {
          seen.add(`${from}:${to}`);
          edges.push([from, to]);
        }
    });
    return { nodes, edges };
  }
  unexplored(map: MapApi, owner: string, region: number | undefined): Point[] {
    const blocks = new Map<string, Point>();
    if (region === undefined) return [];
    for (const p of this.openPoints) {
      if (this.regions.get(key(p)) !== region) continue;
      const tile = map.getTile(p.x, p.y);
      if (!tile || map.isVisibleTile(tile, owner, Math.max(0, p.z - tile.z)))
        continue;
      const block = `${Math.floor(p.x / 8)}:${Math.floor(p.y / 8)}:${p.bridge}`;
      if (!blocks.has(block))
        blocks.set(block, {
          x: p.x,
          y: p.y,
          ...(p.bridge ? { onBridge: true } : {}),
        });
    }
    return [...blocks.values()];
  }
  refreshVisible(map: MapApi, owner: string) {
    let changed = false;
    for (const p of this.cells) {
      const tile = map.getTile(p.x, p.y);
      if (!tile || !map.isVisibleTile(tile, owner, Math.max(0, p.z - tile.z)))
        continue;
      const passable =
        (!p.bridge || map.hasBridgeOnTile(tile)) &&
        map.isPassableTile(tile, this.speed, p.bridge, this.subCell);
      if (passable !== (p.passable !== false)) {
        p.passable = passable;
        changed = true;
      }
    }
    if (changed) this.rebuild();
  }
  closest(p: Point, radius = 8): MapCell | undefined {
    const layers = p.onBridge === undefined ? [false, true] : [p.onBridge];
    for (const onBridge of layers) {
      const exact = this.graph.getNode(key({ x: p.x, y: p.y, onBridge }));
      if (exact) return exact.data;
    }
    let best: MapCell | undefined,
      distance = radius ** 2 + 0.01;
    for (let x = Math.floor(p.x - radius); x <= p.x + radius; x++)
      for (let y = Math.floor(p.y - radius); y <= p.y + radius; y++)
        for (const onBridge of layers) {
          const node = this.graph.getNode(key({ x, y, onBridge }));
          const next = node ? distance2(p, node.data) : Infinity;
          if (next < distance) {
            best = node!.data;
            distance = next;
          }
        }
    return best;
  }
  path(
    from: Point,
    to: Point,
    danger: readonly (Point & { radius: number })[] = [],
  ): Point[] {
    const a = this.closest(from),
      b = this.closest(to);
    if (!a || !b) return [];
    return aStar(this.graph, {
      distance: (a, b) =>
        Math.sqrt(distance2(a.data, b.data)) *
        (danger.some((e) => distance2(b.data, e) <= e.radius ** 2) ? 30 : 1),
      heuristic: (a, b) => Math.sqrt(distance2(a.data, b.data)),
    })
      .find(key(a), key(b))
      .reverse()
      .map((n) => ({
        x: n.data.x,
        y: n.data.y,
        ...(n.data.bridge ? { onBridge: true } : {}),
      }));
  }
  flank(from: Point, to: Point): Point | undefined {
    const primary = this.path(from, to);
    if (primary.length < 24) return;
    const corridor = primary
      .slice(Math.max(0, primary.length - 36), -10)
      .filter((_, i) => i % 6 === 0)
      .map((p) => ({ ...p, radius: 8 }));
    const alternate = this.path(from, to, corridor);
    if (!alternate.length || alternate.length > primary.length * 1.8 + 8)
      return;
    return alternate
      .slice(Math.floor(alternate.length / 2))
      .reverse()
      .find(
        (p) =>
          distance2(p, to) >= 100 &&
          primary.every((q) => distance2(p, q) >= 64),
      );
  }
  static readPregame(
    game: GameApi,
    speed: SpeedType = 1,
    subCell = false,
  ): MapPrior {
    if (game.getCurrentTick() !== 0)
      throw new Error("Map prior must be captured before simulation");
    const map = game.map,
      size = map.getRealMapSize(),
      cells: MapCell[] = [];
    for (let x = 0; x < size.width; x++)
      for (let y = 0; y < size.height; y++) {
        const tile = map.getTile(x, y);
        if (!tile) continue;
        cells.push({
          x,
          y,
          z: tile.z,
          bridge: false,
          passable: map.isPassableTile(tile, speed, false, subCell),
        });
        if (map.hasBridgeOnTile(tile)) {
          const elevation = Math.max(
            0,
            ...map
              .getObjectsOnTile(tile)
              .map((id) => game.getGameObjectData(id))
              .filter((o) => o?.type === ObjectType.Overlay)
              .map((o) => o!.tileElevation),
          );
          cells.push({
            x,
            y,
            z: tile.z + elevation,
            bridge: true,
            passable: map.isPassableTile(tile, speed, true, subCell),
          });
        }
      }
    return new MapPrior(cells, speed, subCell);
  }
}
