/** Only ordinary player observations cross this boundary. Native IDs stay in the bridge. */
export interface Point {
  x: number;
  y: number;
  /** Movement on a bridge must name the bridge layer in the pinned API. */
  onBridge?: boolean;
}
export interface Unit extends Point {
  /** World position in tile units: x/y ground plane, z elevation. */
  position?: Point & { z: number };
  /** Own attack animation/state only; never an enemy target ID. */
  attackState?: number;
  onBridge?: boolean;
  sight?: number;
  ref: string;
  name: string;
  type: number;
  hp: number;
  maxHp: number;
  width: number;
  height: number;
  mobile: boolean;
  idle: boolean;
  harvester: boolean;
  mcv: boolean;
  yard: boolean;
  refinery: boolean;
  radar?: boolean;
  combat: boolean;
  buildStatus?: number;
  repairable?: boolean;
  hasWrenchRepair?: boolean;
  deployed?: boolean;
  crusher?: boolean;
  antiAir?: boolean;
  /** Current own weapon data, used to decide whether deploying can provide fire. */
  weaponRange?: number;
  deployedWeaponRange?: number;
}
export interface Contact extends Point {
  /** Visually observable stance of a currently visible infantry unit. */
  deployed?: boolean;
  position?: Point & { z: number };
  ref: string;
  name: string;
  type: number;
  hp: number;
  maxHp: number;
  observedTick: number;
  airborne?: boolean;
  /** Known weapon range of a currently visible unit; no target or cooldown state. */
  weaponRange?: number;
  canThreatenBuildings?: boolean;
  canThreatenVehicles?: boolean;
}
export interface Product {
  name: string;
  type: number;
  cost: number;
  queue: number;
  radar?: boolean;
}
export interface Queue {
  type: number;
  status: number;
  size: number;
  items: { name: string; quantity: number }[];
}
export interface Observation {
  tick: number;
  side: number;
  credits: number;
  power: { total: number; drain: number; isLowPower: boolean };
  home: Point;
  starts: Point[];
  scoutPoints?: readonly Point[];
  /** Explored, passable observation posts for revisiting known enemy production. */
  scoutRevisitPoints?: readonly Point[];
  /** Public start tiles that our own shroud has already revealed. */
  exploredStarts?: readonly Point[];
  scoutObservedTick?: number;
  defenseRoute?: { towards: Point; point: Point; observedTick: number };
  /** Reachable local guard posts for separate approaches; only explored terrain. */
  defensePosts?: readonly {
    task: string;
    towards: Point;
    point: Point;
    observedTick: number;
  }[];
  baseRally?: Point;
  stagingRoute?: { towards: Point; point: Point; observedTick: number };
  flankApproach?: { towards: Point; point: Point; observedTick: number };
  /** Static-map routes, refreshed from own positions; dynamic enemies are separate. */
  oreFields?: readonly { x: number; y: number; amount: number }[];
  routes?: readonly {
    task: string;
    towards: Point;
    waypoint: Point;
    post?: Point;
    distance: number;
  }[];
  own: Unit[];
  enemies: Contact[];
  /** Currently visible, unowned capturable cash structures, including neutral ones. */
  /** Former mobile contacts absent from their fully explored reachable neighborhood. Not a death event. */
  vacatedContacts?: readonly string[];
  techBuildings?: readonly {
    ref: string;
    name: string;
    x: number;
    y: number;
  }[];
  products: Product[];
  queues: Queue[];
  /** Placement checks are restricted to completely explored footprints around our own base. */
  buildSites: { name: string; x: number; y: number }[];
}
export type Intent = (
  | { kind: "deploy"; refs: string[] }
  | { kind: "stop"; refs: string[] }
  | { kind: "scatter"; refs: string[] }
  | { kind: "queue"; product: Product }
  | { kind: "place"; name: string; x: number; y: number }
  | { kind: "attack" | "crush" | "capture"; refs: string[]; target: string }
  | {
      kind: "attackMove" | "move";
      refs: string[];
      x: number;
      y: number;
      onBridge?: boolean;
    }
  | { kind: "repair"; ref: string }
) & { task?: string };

export const distance2 = (a: Point, b: Point): number =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** Ground weapon geometry uses 3D world distance, including infantry subcells. */
export const weaponDistance2 = (
  a: Point & { position?: Point & { z: number } },
  b: Point & { position?: Point & { z: number } },
): number =>
  a.position && b.position
    ? distance2(a.position, b.position) + (a.position.z - b.position.z) ** 2
    : distance2(a, b);
