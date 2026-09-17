/** Only ordinary player observations cross this boundary. Native IDs stay in the bridge. */
export interface Point {
  x: number;
  y: number;
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
  combat: boolean;
  buildStatus?: number;
  deployed?: boolean;
  crusher?: boolean;
  antiAir?: boolean;
  /** Current own weapon data, used to decide whether deploying can provide fire. */
  weaponRange?: number;
  deployedWeaponRange?: number;
}
export interface Contact extends Point {
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
}
export interface Product {
  name: string;
  type: number;
  cost: number;
  queue: number;
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
  scoutObservedTick?: number;
  defenseRoute?: { towards: Point; point: Point; observedTick: number };
  stagingRoute?: { towards: Point; point: Point; observedTick: number };
  own: Unit[];
  enemies: Contact[];
  products: Product[];
  queues: Queue[];
  /** Placement checks are restricted to completely explored footprints around our own base. */
  buildSites: { name: string; x: number; y: number }[];
}
export type Intent = (
  | { kind: "deploy"; refs: string[] }
  | { kind: "stop"; refs: string[] }
  | { kind: "queue"; product: Product }
  | { kind: "place"; name: string; x: number; y: number }
  | { kind: "attack" | "crush"; refs: string[]; target: string }
  | { kind: "attackMove" | "move"; refs: string[]; x: number; y: number }
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
