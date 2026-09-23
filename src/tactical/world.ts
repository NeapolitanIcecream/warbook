import { distance2, type Point } from "../model.js";

export interface TacticalUnit extends Point {
  ref: string;
  hp: number;
  maxHp: number;
  range: number;
  cooldown?: number;
  infantry?: boolean;
  building?: boolean;
}
export interface TacticalObservation {
  tick: number;
  center: Point;
  goal: Point;
  radius?: number;
  task: "advance" | "defend" | "withdraw" | "assemble";
  own: TacticalUnit[];
  enemies: TacticalUnit[];
  ground?: readonly Point[];
}
export type TacticalAction =
  | { kind: "keep" | "stop"; ref: string }
  | { kind: "attack"; ref: string; target: string }
  | { kind: "move" | "attackMove"; ref: string; point: Point };
export interface TacticalWorld {
  global: number[];
  entities: number[][];
  ownCount: number;
  candidates: number[][][];
  targets: number[][];
  actions: TacticalAction[][];
}
export const TACTICAL_ENTITY = 20,
  TACTICAL_GLOBAL = 16,
  TACTICAL_CANDIDATE = 24;
const fixed = (v: number[], n: number) => {
  if (v.length > n || v.some((x) => !Number.isFinite(x)))
    throw new Error("Invalid tactical feature");
  return [...v, ...Array(n - v.length).fill(0)];
};
const kinds = ["keep", "stop", "move", "attackMove", "attack"];
const key = (p: Point) => `${p.x}:${p.y}:${!!p.onBridge}`;

/** Only relative coordinates, visible enemy properties and own weapon state enter the policy. */
export function tacticalWorld(o: TacticalObservation): TacticalWorld {
  const all = [...o.own, ...o.enemies];
  const global = fixed(
    [
      ...["advance", "defend", "withdraw", "assemble"].map((k) =>
        Number(k === o.task),
      ),
      (o.goal.x - o.center.x) / 32,
      (o.goal.y - o.center.y) / 32,
      o.own.length / 16,
      o.enemies.length / 16,
      Number(o.radius !== undefined),
      (o.radius ?? 0) / 32,
    ],
    TACTICAL_GLOBAL,
  );
  const entities = all.map((u, i) =>
    fixed(
      [
        Number(i < o.own.length),
        (u.x - o.center.x) / 16,
        (u.y - o.center.y) / 16,
        u.hp / Math.max(1, u.maxHp),
        Math.log1p(u.maxHp) / 10,
        u.range / 16,
        Number(i < o.own.length && u.cooldown !== undefined),
        i < o.own.length ? (u.cooldown ?? 0) / 60 : 0,
        Number(!!u.onBridge),
        Number(!!u.infantry),
        Number(!!u.building),
        (o.goal.x - u.x) / 32,
        (o.goal.y - u.y) / 32,
      ],
      TACTICAL_ENTITY,
    ),
  );
  const ground = o.ground ? new Set(o.ground.map(key)) : undefined;
  const actions = o.own.map((u) => {
    const result: TacticalAction[] = [
      { kind: "keep", ref: u.ref },
      { kind: "stop", ref: u.ref },
    ];
    const points: Point[] = [o.goal];
    for (const length of [2, 4])
      for (const [dx, dy] of [
        [-1, -1],
        [-1, 0],
        [-1, 1],
        [0, -1],
        [0, 1],
        [1, -1],
        [1, 0],
        [1, 1],
      ])
        points.push({
          x: u.x + dx * length,
          y: u.y + dy * length,
          ...(u.onBridge ? { onBridge: true } : {}),
        });
    const seen = new Set<string>();
    for (const point of points) {
      const k = key(point);
      if (
        seen.has(k) ||
        (o.radius !== undefined &&
          distance2(point, o.center) > o.radius ** 2) ||
        (ground && !ground.has(k))
      )
        continue;
      seen.add(k);
      result.push(
        { kind: "move", ref: u.ref, point },
        { kind: "attackMove", ref: u.ref, point },
      );
    }
    for (const e of o.enemies)
      result.push({ kind: "attack", ref: u.ref, target: e.ref });
    return result;
  });
  const targets = actions.map((row) =>
    row.map((a) =>
      a.kind === "attack" ? all.findIndex((e) => e.ref === a.target) : -1,
    ),
  );
  const candidates = actions.map((row, i) =>
    row.map((a, j) => {
      const u = o.own[i],
        target = all[targets[i][j]];
      const point = "point" in a ? a.point : (target ?? u);
      return fixed(
        [
          ...kinds.map((k) => Number(a.kind === k)),
          (point.x - u.x) / 16,
          (point.y - u.y) / 16,
          Math.sqrt(distance2(u, point)) / 16,
          (point.x - o.goal.x) / 32,
          (point.y - o.goal.y) / 32,
          Number(!!point.onBridge),
          Number(!!target),
          target ? target.hp / Math.max(1, target.maxHp) : 0,
          target ? Math.sqrt(distance2(u, target)) / Math.max(1, u.range) : 0,
        ],
        TACTICAL_CANDIDATE,
      );
    }),
  );
  return {
    global,
    entities,
    ownCount: o.own.length,
    candidates,
    targets,
    actions,
  };
}

export function focusLabels(
  o: TacticalObservation,
  w: TacticalWorld,
): number[] {
  return o.own.map((u, i) => {
    const target = [...o.enemies].sort(
      (a, b) =>
        a.hp / a.maxHp - b.hp / b.maxHp || distance2(u, a) - distance2(u, b),
    )[0];
    const j = w.actions[i].findIndex((a) =>
      target
        ? a.kind === "attack" && a.target === target.ref
        : a.kind === "attackMove" &&
          a.point.x === o.goal.x &&
          a.point.y === o.goal.y,
    );
    return j < 0 ? 0 : j;
  });
}
