import createGraph from "ngraph.graph";
import { aStar } from "ngraph.path";
import { TerrainType, ObjectType, type GameApi } from "@chronodivide/game-api";
import { distance2, type Point } from "./model.js";

export interface MapCell extends Point {
  z: number;
  bridge: boolean;
}
const key = (p: Point) => `${p.x}:${p.y}`;

/** A pregame map, frozen before the first simulation step. No player objects,
 * remaining resources, live occupancy or engine path caches enter this graph. */
export class MapPrior {
  private graph = createGraph<MapCell>();
  readonly points: readonly MapCell[];
  constructor(cells: readonly MapCell[]) {
    this.points = cells;
    for (const cell of cells) this.graph.addNode(key(cell), cell);
    for (const p of cells)
      for (const [dx, dy] of [
        [-1, 0],
        [-1, -1],
        [0, -1],
        [1, -1],
      ]) {
        const q = this.graph.getNode(key({ x: p.x + dx, y: p.y + dy }));
        if (
          q &&
          Math.abs(p.z - q.data.z) <= (p.bridge || q.data.bridge ? 0 : 1)
        )
          this.graph.addLink(key(p), q.id);
      }
  }

  closest(p: Point, radius = 8): MapCell | undefined {
    const exact = this.graph.getNode(key(p));
    if (exact) return exact.data;
    let best: MapCell | undefined,
      d = radius ** 2 + 0.01;
    for (let x = Math.floor(p.x - radius); x <= p.x + radius; x++)
      for (let y = Math.floor(p.y - radius); y <= p.y + radius; y++) {
        const node = this.graph.getNode(key({ x, y }));
        const next = node ? distance2(p, node.data) : Infinity;
        if (next < d) {
          best = node!.data;
          d = next;
        }
      }
    return best;
  }

  path(from: Point, to: Point): Point[] {
    const a = this.closest(from),
      b = this.closest(to);
    if (!a || !b) return [];
    return aStar(this.graph, {
      distance: (a, b) => Math.sqrt(distance2(a.data, b.data)),
      heuristic: (a, b) => Math.sqrt(distance2(a.data, b.data)),
    })
      .find(key(a), key(b))
      .reverse()
      .map((n) => ({ x: n.data.x, y: n.data.y }));
  }

  static readPregame(game: GameApi): MapPrior {
    if (game.getCurrentTick() !== 0)
      throw new Error("Map prior must be captured before simulation");
    const map = game.map,
      size = map.getRealMapSize(),
      blocked = new Set<string>();
    // Neutral structures are fixed map scenery at initialization; no combatant query.
    for (const id of game.getNeutralUnits(
      (r) => r.type === ObjectType.Building,
    )) {
      const b = game.getUnitData(id)!;
      for (let x = b.tile.rx; x < b.tile.rx + b.foundation.width; x++)
        for (let y = b.tile.ry; y < b.tile.ry + b.foundation.height; y++)
          blocked.add(key({ x, y }));
    }
    const cells: MapCell[] = [];
    for (let x = 0; x < size.width; x++)
      for (let y = 0; y < size.height; y++) {
        const tile = map.getTile(x, y);
        if (!tile || blocked.has(key({ x, y }))) continue;
        const bridge = map.hasBridgeOnTile(tile);
        if (
          !bridge &&
          [
            TerrainType.Water,
            TerrainType.Cliff,
            TerrainType.Rock1,
            TerrainType.Rock2,
          ].includes(tile.terrainType)
        )
          continue;
        // Elevation is read only from initial static bridge overlays, never units.
        const elevation = bridge
          ? Math.max(
              0,
              ...map
                .getObjectsOnTile(tile)
                .map((id) => game.getGameObjectData(id))
                .filter((o) => o?.type === ObjectType.Overlay)
                .map((o) => o!.tileElevation),
            )
          : 0;
        cells.push({ x, y, z: tile.z + elevation, bridge });
      }
    return new MapPrior(cells);
  }
}
