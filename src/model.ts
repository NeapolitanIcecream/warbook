/** Only ordinary player observations cross this boundary. Native IDs stay in the bridge. */
export interface Point {
  x: number;
  y: number;
}
export interface Unit extends Point {
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
}
export interface Contact extends Point {
  ref: string;
  name: string;
  type: number;
  hp: number;
  maxHp: number;
  observedTick: number;
  airborne?: boolean;
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
  own: Unit[];
  enemies: Contact[];
  products: Product[];
  queues: Queue[];
  /** Placement checks are restricted to completely explored footprints around our own base. */
  buildSites: { name: string; x: number; y: number }[];
}
export type Intent =
  | { kind: "deploy"; refs: string[] }
  | { kind: "queue"; product: Product }
  | { kind: "place"; name: string; x: number; y: number }
  | { kind: "attack" | "crush"; refs: string[]; target: string }
  | { kind: "attackMove" | "move"; refs: string[]; x: number; y: number }
  | { kind: "repair"; ref: string };

export const distance2 = (a: Point, b: Point): number =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
