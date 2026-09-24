import {
  distance2,
  type Observation,
  type Point,
  type Contact,
  type Unit,
} from "../model.js";
import { committedStock } from "../control/program-production.js";
import type {
  CombatMission,
  ProgramProductionPlan,
  StrategicPlan,
} from "../control/contracts.js";

export const TASK_SLOTS = 16;
export const RESERVE = TASK_SLOTS,
  DEPLOY = TASK_SLOTS + 1,
  KEEP_UNIT = TASK_SLOTS + 2,
  UNASSIGNED = TASK_SLOTS + 3;
export const ENTITY_SIZE = 64,
  REGION_SIZE = 16,
  PRODUCT_SIZE = 24,
  GOAL_SIZE = 32,
  TASK_SIZE = 32,
  GLOBAL_SIZE = 32,
  QUEUE_SIZE = 16;
export const TASK_KINDS = [
  "keep",
  "release",
  "assemble",
  "advance",
  "defend",
  "withdraw",
  "scout",
  "capture",
  "harvest",
  "screen",
  "hold",
] as const;
export const AMOUNTS = [1, 2, 4, 8, -1] as const;
export const CASH_FLOORS = [0, 250, 500, 1000, 2000, 4000] as const;
export const oneHot = (i: number, n: number) =>
  Array.from({ length: n }, (_, j) => Number(i === j));
export const logCount = (n: number) => Math.log1p(Math.max(0, n)) / 5;
export const fixed = (x: number[], n: number) => {
  if (x.length > n || x.some((v) => !Number.isFinite(v)))
    throw new Error(`Invalid feature row ${x.length}/${n}`);
  return [...x, ...Array(n - x.length).fill(0)];
};
export interface Goal extends Point {
  kind:
    | "native"
    | "region"
    | "own"
    | "enemy"
    | "memory"
    | "ore"
    | "tech"
    | "start"
    | "previous";
  ref?: string;
}
export interface TaskSlot {
  active: boolean;
  kind: CombatMission["kind"];
  goal?: Goal;
  allowCrush: boolean;
  interrupt: boolean;
  focus?: boolean;
  since: number;
}
export interface ProgramState {
  slots: TaskSlot[];
  roles: Map<string, number>;
  production: ProgramProductionPlan;
}
export function initialProgram(): ProgramState {
  return {
    slots: Array.from({ length: TASK_SLOTS }, () => ({
      active: false,
      kind: "hold",
      allowCrush: true,
      interrupt: false,
      since: 0,
    })),
    roles: new Map(),
    production: {
      id: "commander-production",
      revision: 0,
      deploymentUnits: [],
      program: {
        queues: Array.from({ length: 6 }, (_, queue) => ({
          queue,
          mode: "run",
          target: 0,
          reserve: 0,
        })),
        placements: [],
        repair: [],
        sell: [],
      },
    },
  };
}
export interface CommanderWorld {
  tick: number;
  global: number[];
  entities: number[][];
  entityEdges: [number, number][];
  regions: number[][];
  regionEdges: [number, number][];
  products: number[][];
  productEdges: [number, number][];
  goals: number[][];
  tasks: number[][];
  placements: number[][];
  queues: number[][];
  queueNames: string[];
  entityNames: string[];
  goalEntities: number[];
  goalNames: string[];
  unitIndices: number[];
  buildingIndices: number[];
  /** Pointer identities and legality metadata are not network feature columns. */
  ownRefs: string[];
  unitRefs: string[];
  buildingRefs: string[];
  productNames: string[];
  productQueues: number[];
  goalObjects: Goal[];
  placementObjects: { name: string; x: number; y: number; queue: number }[];
  previousRoles: number[];
  previousKinds: number[];
  previousGoals: number[];
  unitCapabilities: {
    miner: boolean;
    engineer: boolean;
    deploy: boolean;
    building: boolean;
  }[];
  buildingCapabilities: { repair: boolean; sell: boolean }[];
}
export class ContactMemory {
  private contacts = new Map<string, Contact>();
  observe(o: Observation) {
    for (const ref of o.vacatedContacts ?? []) this.contacts.delete(ref);
    for (const own of o.own) this.contacts.delete(own.ref);
    for (const e of o.enemies) this.contacts.set(e.ref, e);
  }
  values() {
    return [...this.contacts.values()];
  }
}
const pkey = (p: Point) => `${p.x}:${p.y}:${!!p.onBridge}`;
const hp = (u: { hp: number; maxHp: number }) => u.hp / Math.max(1, u.maxHp);
export function buildWorld(
  o: Observation,
  state: ProgramState,
  memory: ContactMemory,
): CommanderWorld {
  const catalogue = o.catalogue ?? o.products;
  const visible = new Set(o.enemies.map((u) => u.ref));
  const enemies = memory.values();
  const ownRefs = o.own.map((u) => u.ref);
  const ownIndex = new Map(ownRefs.map((ref, i) => [ref, i]));
  const controlled = o.own.filter((u) => u.type !== 2 || u.yard);
  const buildings = o.own.filter((u) => u.type === 2);
  const all = [...o.own, ...enemies];
  const entities = all.map((u, i) => {
    const self = i < o.own.length,
      own = self ? (u as Unit) : undefined;
    return fixed(
      [
        Number(self),
        Number(!self && visible.has(u.ref)),
        Number(!self && !visible.has(u.ref)),
        ...oneHot(u.type, 8),
        (u.x - o.home.x) / 128,
        (u.y - o.home.y) / 128,
        (u.position?.z ?? 0) / 8,
        Number(!!u.onBridge),
        hp(u),
        Math.log1p(u.maxHp) / 10,
        (u.weaponRange ?? 0) / 16,
        Number(!!u.deployed),
        Number(!!own?.mobile),
        Number(!!own?.idle),
        Number(!!own?.harvester),
        Number(!!own?.mcv),
        Number(!!own?.yard),
        Number(!!own?.refinery),
        Number(!!own?.engineer),
        Number(!!own?.radar),
        Number(!!own?.antiAir),
        Number(!!own?.combat),
        Number(!!own?.sellable),
        Number(!!own?.repairable),
        Number(!!own?.hasWrenchRepair),
        (own?.cargo ?? 0) / 40,
        (own?.attackState ?? 0) / 8,
        self ? 0 : (o.tick - (u as Contact).observedTick) / 54000,
        ...oneHot(
          self ? (state.roles.get(u.ref) ?? UNASSIGNED) : -1,
          TASK_SLOTS + 2,
        ),
        Number(self && state.production.program.repair.includes(u.ref)),
      ],
      ENTITY_SIZE,
    );
  });
  const entityEdges: [number, number][] = [];
  for (let i = 0; i < all.length; i++) {
    const nearest = all
      .map((u, j) => ({ j, d: distance2(u, all[i]) }))
      .filter((p) => p.j !== i && p.d <= 16 ** 2)
      .sort((a, b) => a.d - b.d || a.j - b.j)
      .slice(0, 8);
    for (const { j } of nearest) entityEdges.push([j, i]);
  }
  const regions = (o.regions ?? []).map((r) =>
    fixed(
      [
        (r.x - o.home.x) / 128,
        (r.y - o.home.y) / 128,
        r.height / 8,
        Number(!!r.onBridge),
        r.explored,
        r.cells / 64,
        Number(r.vehicle),
        Number(r.infantry),
        logCount(o.own.filter((u) => distance2(u, r) <= 8 ** 2).length),
        logCount(o.enemies.filter((u) => distance2(u, r) <= 8 ** 2).length),
        Math.log1p(
          (o.oreFields ?? [])
            .filter((f) => distance2(f, r) <= 8 ** 2)
            .reduce((n, f) => n + f.amount, 0),
        ) / 12,
      ],
      REGION_SIZE,
    ),
  );
  const products = catalogue.map((p) =>
    fixed(
      [
        ...oneHot(p.queue, 6),
        ...oneHot(p.type, 8),
        p.cost / 3000,
        (p.power ?? 0) / 500,
        p.buildTimeMultiplier ?? 1,
        Number(p.available ?? o.products.some((x) => x.name === p.name)),
        logCount(o.own.filter((u) => u.name === p.name).length),
        logCount(committedStock(o, p.name)),
        (p.prerequisiteGroups ?? []).filter(
          (g) => !o.own.some((u) => g.includes(u.name)),
        ).length / 8,
        Number(!!p.grants),
        Number(!!p.radar),
        Number(
          (p.prerequisiteOverride ?? []).some((n) =>
            o.own.some((u) => u.name === n),
          ),
        ),
      ],
      PRODUCT_SIZE,
    ),
  );
  const productIndex = new Map(catalogue.map((p, i) => [p.name, i]));
  const productEdges: [number, number][] = [];
  for (let i = 0; i < catalogue.length; i++)
    for (const name of new Set([
      ...(catalogue[i].prerequisiteGroups ?? []).flat(),
      ...(catalogue[i].prerequisiteOverride ?? []),
    ])) {
      const j = productIndex.get(name);
      if (j !== undefined && j !== i) productEdges.push([j, i]);
    }
  const goalObjects: Goal[] = [];
  const seen = new Set<string>();
  const add = (g: Goal) => {
    const key = `${pkey(g)}:${g.kind}:${g.ref ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      goalObjects.push(g);
    }
  };
  add({ ...o.home, kind: "native" });
  add({ ...o.home, kind: "start" });
  for (const r of o.regions ?? [])
    add({ x: r.x, y: r.y, onBridge: r.onBridge, kind: "region" });
  for (const u of o.own)
    add({ x: u.x, y: u.y, onBridge: u.onBridge, ref: u.ref, kind: "own" });
  for (const u of enemies)
    add({
      x: u.x,
      y: u.y,
      onBridge: u.onBridge,
      ref: u.ref,
      kind: visible.has(u.ref) ? "enemy" : "memory",
    });
  for (const p of o.oreFields ?? []) add({ ...p, kind: "ore" });
  for (const p of o.techBuildings ?? []) add({ ...p, kind: "tech" });
  for (const p of o.capturableBuildings ?? []) add({ ...p, kind: "tech" });
  for (const p of o.starts) add({ ...p, kind: "start" });
  for (const s of state.slots) if (s.goal) add({ ...s.goal, kind: "previous" });
  const kinds = [
    "native",
    "region",
    "own",
    "enemy",
    "memory",
    "ore",
    "tech",
    "start",
    "previous",
  ];
  const goals = goalObjects.map((g) => {
    const nearOwn = o.own.filter((u) => distance2(u, g) <= 10 ** 2),
      nearEnemy = o.enemies.filter((u) => distance2(u, g) <= 10 ** 2);
    const object = all.find((u) => u.ref === g.ref),
      region = o.regions?.find((r) => pkey(r) === pkey(g));
    return fixed(
      [
        (g.x - o.home.x) / 128,
        (g.y - o.home.y) / 128,
        Number(!!g.onBridge),
        ...oneHot(kinds.indexOf(g.kind), 9),
        ...(object ? oneHot(object.type, 8) : Array(8).fill(0)),
        object ? hp(object) : 0,
        logCount(nearOwn.length),
        logCount(nearEnemy.length),
        logCount(nearOwn.filter((u) => u.combat).length),
        logCount(nearEnemy.filter((u) => (u.weaponRange ?? 0) > 0).length),
        Math.log1p(
          (o.oreFields ?? [])
            .filter((f) => distance2(f, g) <= 8 ** 2)
            .reduce((n, f) => n + f.amount, 0),
        ) / 12,
        region?.explored ?? Number(g.kind !== "region"),
        Number(!!region?.vehicle),
        Number(!!region?.infantry),
        region?.height ?? 0,
      ],
      GOAL_SIZE,
    );
  });
  const previousGoals = state.slots.map((s) =>
    Math.max(
      0,
      goalObjects.findIndex(
        (g) =>
          s.goal &&
          pkey(g) === pkey(s.goal) &&
          g.ref === s.goal.ref &&
          (g.kind === "native") === (s.goal.kind === "native"),
      ),
    ),
  );
  const tasks = state.slots.map((s, i) => {
    const members = o.own.filter((u) => state.roles.get(u.ref) === i);
    const avg = (f: (u: Unit) => number) =>
      members.reduce((n, u) => n + f(u), 0) / Math.max(1, members.length);
    return fixed(
      [
        Number(s.active),
        ...oneHot(TASK_KINDS.indexOf(s.kind as any), TASK_KINDS.length),
        logCount(members.length),
        avg(hp),
        avg((u) => (u.x - o.home.x) / 128),
        avg((u) => (u.y - o.home.y) / 128),
        s.goal ? (s.goal.x - o.home.x) / 128 : 0,
        s.goal ? (s.goal.y - o.home.y) / 128 : 0,
        Number(!!s.goal?.onBridge),
        (o.tick - s.since) / 54000,
        Number(s.allowCrush),
        Number(s.interrupt),
        logCount(members.filter((u) => u.harvester).length),
        logCount(members.filter((u) => u.type === 3).length),
        Number(!!s.focus),
      ],
      TASK_SIZE,
    );
  });
  const placementObjects = (o.placementChoices ?? o.buildSites)
    .filter((p) =>
      o.queues.some((q) => q.status === 3 && q.items[0]?.name === p.name),
    )
    .map((p) => ({
      ...p,
      queue: catalogue.find((x) => x.name === p.name)?.queue ?? 0,
    }));
  const placements = placementObjects.map((p) =>
    fixed(
      [
        (p.x - o.home.x) / 128,
        (p.y - o.home.y) / 128,
        p.queue,
        (catalogue.find((x) => x.name === p.name)?.cost ?? 0) / 3000,
        Math.sqrt(
          Math.min(
            128 ** 2,
            ...o.own.filter((u) => u.type === 2).map((u) => distance2(u, p)),
          ),
        ) / 128,
        Math.sqrt(
          Math.min(128 ** 2, ...o.enemies.map((u) => distance2(u, p))),
        ) / 128,
        Math.sqrt(
          Math.min(
            128 ** 2,
            ...(o.oreFields ?? []).map((f) => distance2(f, p)),
          ),
        ) / 128,
        logCount(o.enemies.filter((u) => distance2(u, p) < 12 ** 2).length),
      ],
      GOAL_SIZE,
    ),
  );
  const global = fixed(
    [
      o.tick / 54000,
      Math.log1p(o.credits) / 10,
      o.power.total / 500,
      o.power.drain / 500,
      Number(o.power.isLowPower),
      o.home.x / 128,
      o.home.y / 128,
      Number(o.side === 0),
      logCount(o.own.length),
      logCount(o.enemies.length),
      logCount(enemies.length),
      ...o.queues.flatMap((q) => [q.status / 3, logCount(q.size)]),
    ],
    GLOBAL_SIZE,
  );
  const queues = Array.from({ length: 6 }, (_, i) => {
    const q = o.queues.find((q) => q.type === i),
      p = state.production.program.queues.find((q) => q.queue === i);
    return fixed(
      [
        q?.status ?? 0,
        logCount(q?.size ?? 0),
        ...oneHot(["run", "pause", "cancel"].indexOf(p?.mode ?? "run"), 3),
        logCount(p?.target ?? 0),
        Number(p?.target === -1),
        (p?.reserve ?? 0) / 4000,
        ...oneHot(i, 6),
      ],
      QUEUE_SIZE,
    );
  });
  const queueNames = Array.from(
    { length: 6 },
    (_, i) =>
      state.production.program.queues.find((q) => q.queue === i)?.product ??
      o.queues.find((q) => q.type === i)?.items[0]?.name ??
      "",
  );
  return {
    tick: o.tick,
    global,
    entities,
    entityEdges,
    regions,
    regionEdges: (o.regionEdges ?? []).map(([a, b]) => [a, b]),
    products,
    productEdges,
    goals,
    tasks,
    placements,
    queues,
    queueNames,
    entityNames: all.map((u) => u.name),
    goalEntities: goalObjects.map((g) => all.findIndex((u) => u.ref === g.ref)),
    goalNames: goalObjects.map(
      (g) =>
        (g as Goal & { name?: string }).name ??
        all.find((u) => u.ref === g.ref)?.name ??
        "",
    ),
    ownRefs,
    unitRefs: controlled.map((u) => u.ref),
    buildingRefs: buildings.map((u) => u.ref),
    unitIndices: controlled.map((u) => ownIndex.get(u.ref)!),
    buildingIndices: buildings.map((u) => ownIndex.get(u.ref)!),
    productNames: catalogue.map((p) => p.name),
    productQueues: catalogue.map((p) => p.queue),
    goalObjects,
    placementObjects,
    previousRoles: controlled.map((u) => state.roles.get(u.ref) ?? UNASSIGNED),
    previousKinds: state.slots.map((s) =>
      s.active ? TASK_KINDS.indexOf(s.kind as any) : 1,
    ),
    previousGoals,
    unitCapabilities: controlled.map((u) => ({
      miner: u.harvester,
      engineer: !!u.engineer,
      deploy: u.mcv || u.yard,
      building: u.type === 2,
    })),
    buildingCapabilities: buildings.map((u) => ({
      repair: !!u.repairable,
      sell: !!u.sellable,
    })),
  };
}

export interface CommanderAction {
  queues: number[];
  amounts: number[];
  cash: number[];
  kinds: number[];
  goals: number[];
  engagement: number[];
  units: number[];
  buildings: number[];
  placements: number[];
}
export function keepAction(w: CommanderWorld): CommanderAction {
  return {
    queues: Array(6).fill(0),
    amounts: Array(6).fill(0),
    cash: Array(6).fill(0),
    kinds: Array(TASK_SLOTS).fill(0),
    goals: [...w.previousGoals],
    engagement: Array(TASK_SLOTS).fill(0),
    units: w.unitRefs.map(() => KEEP_UNIT),
    buildings: w.buildingRefs.map(() => 0),
    placements: [0, 0],
  };
}
export function goalMask(w: CommanderWorld, kind: number): boolean[] {
  const actual = TASK_KINDS[kind];
  return w.goalObjects.map((g) =>
    actual === "harvest"
      ? g.kind === "ore" || g.kind === "native"
      : actual === "capture"
        ? g.kind === "tech"
        : g.kind !== "native",
  );
}
export function roleMask(
  w: CommanderWorld,
  unit: number,
  kinds: readonly number[],
): boolean[] {
  const c = w.unitCapabilities[unit];
  const tasks = kinds.map((k, i) => {
    const kind = k === 0 ? w.previousKinds[i] : k;
    return (
      !c.building &&
      kind >= 2 &&
      (TASK_KINDS[kind] !== "harvest" || c.miner) &&
      (TASK_KINDS[kind] !== "capture" || c.engineer)
    );
  });
  return [
    ...tasks,
    true,
    c.deploy,
    w.previousRoles[unit] >= RESERVE || tasks[w.previousRoles[unit]],
    true,
  ];
}
