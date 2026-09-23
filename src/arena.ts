import {
  Bot,
  cdapi,
  ObjectType,
  OrderType,
  type GameApi,
  type UnitData,
  type GameInstanceApi,
} from "@chronodivide/game-api";
import { MapPrior } from "./map-prior.js";
import { distance2, type Point } from "./model.js";

export interface ArenaUnit extends Point {
  ref: string;
  hp: number;
  maxHp: number;
  range: number;
  cooldown?: number;
}
export interface ArenaObservation {
  tick: number;
  elapsed: number;
  center: Point;
  radius: number;
  own: ArenaUnit[];
  enemies: ArenaUnit[];
}
export type ArenaAction =
  | { kind: "keep"; ref: string }
  | { kind: "stop"; ref: string }
  | { kind: "attack"; ref: string; target: string }
  | { kind: "move" | "attackMove"; ref: string; point: Point };
export interface ArenaPolicy {
  decide(o: ArenaObservation): { actions: ArenaAction[]; record?: unknown };
}
export class NativeArenaPolicy implements ArenaPolicy {
  constructor(readonly mode: "attack-move" | "focus") {}
  decide(o: ArenaObservation) {
    const actions: ArenaAction[] = o.own.map((u) => {
      const enemies = [...o.enemies].sort(
        (a, b) =>
          a.hp / a.maxHp - b.hp / b.maxHp || distance2(u, a) - distance2(u, b),
      );
      if (this.mode === "focus" && enemies.length)
        return { kind: "attack", ref: u.ref, target: enemies[0].ref };
      const p = enemies.length
        ? {
            x: Math.round(
              enemies.reduce((n, e) => n + e.x, 0) / enemies.length,
            ),
            y: Math.round(
              enemies.reduce((n, e) => n + e.y, 0) / enemies.length,
            ),
          }
        : o.center;
      return { kind: "attackMove", ref: u.ref, point: p };
    });
    return { actions };
  }
}
class ArenaBot extends Bot {
  selected: number[] = [];
  private references = new Map<number, string>();
  private current = new Map<string, number>();
  private last = new Map<number, string>();
  private targets = new Map<number, Point>();
  allOwn() {
    return this.player
      .getVisibleUnits("self")
      .map((id) => this.game.getUnitData(id)!)
      .filter(Boolean);
  }
  assign(ids: number[], points: Point[]) {
    this.selected = ids;
    ids.forEach((id, i) => this.targets.set(id, points[i]));
  }
  prepare() {
    for (const id of this.selected) {
      const u = this.game.getUnitData(id),
        p = this.targets.get(id)!;
      if (!u) continue;
      if (
        !this.last.has(id) ||
        (u.isIdle && distance2({ x: u.tile.rx, y: u.tile.ry }, p) > 4)
      ) {
        this.player.actions.orderUnits([id], OrderType.Move, p.x, p.y, false);
        this.last.set(id, "setup");
      }
    }
  }
  ready() {
    return this.selected.every((id) => {
      const u = this.game.getUnitData(id);
      return (
        u &&
        distance2({ x: u.tile.rx, y: u.tile.ry }, this.targets.get(id)!) <= 4
      );
    });
  }
  begin() {
    this.last.clear();
    for (const id of this.selected)
      this.player.actions.orderUnits([id], OrderType.Stop);
  }
  private ref(id: number) {
    let r = this.references.get(id);
    if (!r) {
      r = `unit-${this.references.size}`;
      this.references.set(id, r);
    }
    this.current.set(r, id);
    return r;
  }
  observe(center: Point, radius: number, start: number): ArenaObservation {
    this.current.clear();
    const convert = (u: UnitData, own: boolean): ArenaUnit => ({
      ref: this.ref(u.id),
      x: u.tile.rx,
      y: u.tile.ry,
      onBridge: u.onBridge,
      hp: u.hitPoints,
      maxHp: u.maxHitPoints,
      range: u.primaryWeapon?.maxRange ?? 0,
      ...(own ? { cooldown: u.primaryWeapon?.cooldownTicks ?? 0 } : {}),
    });
    const owned = new Set(this.player.getVisibleUnits("self"));
    return {
      tick: this.game.getCurrentTick(),
      elapsed: this.game.getCurrentTick() - start,
      center,
      radius,
      own: this.selected
        .filter((id) => owned.has(id))
        .map((id) => this.game.getUnitData(id)!)
        .filter((u) => u && u.hitPoints > 0)
        .map((u) => convert(u, true)),
      enemies: this.player
        .getVisibleUnits("enemy")
        .map((id) => this.game.getUnitData(id)!)
        .filter((u) => u && u.name === "MTNK" && u.hitPoints > 0)
        .map((u) => convert(u, false)),
    };
  }
  act(observation: ArenaObservation, actions: readonly ArenaAction[]) {
    const own = new Set(observation.own.map((u) => u.ref)),
      visible = new Set(observation.enemies.map((u) => u.ref)),
      seen = new Set<string>();
    for (const action of actions) {
      if (!own.has(action.ref) || seen.has(action.ref))
        throw new Error("Arena ownership conflict");
      seen.add(action.ref);
      if (action.kind === "keep") continue;
      if (action.kind === "attack" && !visible.has(action.target))
        throw new Error("Arena target not visible");
      const id = this.current.get(action.ref)!,
        key = JSON.stringify(action),
        unit = this.game.getUnitData(id)!;
      if (this.last.get(id) === key && !unit.isIdle) continue;
      if (action.kind === "attack")
        this.player.actions.orderUnits(
          [id],
          OrderType.Attack,
          this.current.get(action.target)!,
        );
      else if (action.kind === "stop")
        this.player.actions.orderUnits([id], OrderType.Stop);
      else
        this.player.actions.orderUnits(
          [id],
          action.kind === "move" ? OrderType.Move : OrderType.AttackMove,
          action.point.x,
          action.point.y,
          !!action.point.onBridge,
        );
      this.last.set(id, key);
    }
  }
}

/** Native initial armies + actual movement preparation. No spawn/teleport/restore hook. */
export async function runArena(options: {
  mixDir: string;
  map: string;
  tanks: number;
  unitCount: number;
  policies: [ArenaPolicy, ArenaPolicy];
  decisionPeriod?: number;
  maxBattleTicks?: number;
  record?: (
    side: number,
    o: ArenaObservation,
    result: ReturnType<ArenaPolicy["decide"]>,
  ) => void;
}) {
  await cdapi.init(options.mixDir);
  const bots = [
    new ArenaBot("ArenaA", "Americans"),
    new ArenaBot("ArenaB", "Americans"),
  ] as const;
  let game: GameInstanceApi | undefined;
  try {
    game = await cdapi.createGame({
      mapName: options.map,
      gameMode: cdapi.getAvailableGameModes(options.map)[0],
      shortGame: false,
      mcvRepacks: true,
      cratesAppear: false,
      superWeapons: false,
      gameSpeed: 4,
      credits: 0,
      unitCount: options.unitCount,
      buildOffAlly: false,
      agents: [...bots],
    });
    const army = bots.map((b) =>
      b
        .allOwn()
        .filter((u) => u.name === "MTNK")
        .slice(0, options.tanks),
    );
    if (army.some((a) => a.length !== options.tanks))
      throw new Error(
        `Native starts provided ${army.map((a) => a.length).join("/")} requested tanks`,
      );
    const navigation = MapPrior.readPregame(game.gameApi, 1);
    const start = bots.map((b) => b.allOwn().find((u) => u.rules.deploysInto)!);
    const homes = start.map((u) => ({ x: u.tile.rx, y: u.tile.ry }));
    const middle = {
      x: (homes[0].x + homes[1].x) / 2,
      y: (homes[0].y + homes[1].y) / 2,
    };
    const selected = new Set(army.flatMap((a) => a.map((u) => u.id)));
    const outsiders = bots
      .flatMap((b) => b.allOwn())
      .filter((u) => !selected.has(u.id))
      .map((u) => ({
        id: u.id,
        hp: u.hitPoints,
        x: u.tile.rx,
        y: u.tile.ry,
        range: u.primaryWeapon?.maxRange ?? 0,
      }));
    const radius = 10;
    const center = navigation.points
      .filter(
        (p) =>
          !p.bridge &&
          outsiders.every((u) => distance2(p, u) > (radius + u.range + 3) ** 2),
      )
      .sort((a, b) => distance2(a, middle) - distance2(b, middle))
      .find(
        (p) =>
          navigation.points.filter(
            (q) => !q.bridge && q.z === p.z && distance2(p, q) <= 8 ** 2,
          ).length >= 100,
      );
    if (!center) throw new Error("No isolated open arena in this normal start");
    const dx = homes[1].x - homes[0].x,
      dy = homes[1].y - homes[0].y,
      norm = Math.hypot(dx, dy);
    const slots = [-1, 1].map((sign) => {
      const anchor = {
        x: center.x + ((sign * dx) / norm) * 6,
        y: center.y + ((sign * dy) / norm) * 6,
      };
      return navigation.points
        .filter(
          (p) =>
            !p.bridge &&
            p.z === center.z &&
            distance2(p, center) <= radius ** 2 &&
            distance2(p, anchor) <= 3 ** 2,
        )
        .sort((a, b) => distance2(a, anchor) - distance2(b, anchor))
        .slice(0, options.tanks)
        .map((p) => ({ x: p.x, y: p.y }));
    });
    if (slots.some((s) => s.length !== options.tanks))
      throw new Error("Arena formation unavailable");
    bots.forEach((b, i) =>
      b.assign(
        army[i].map((u) => u.id),
        slots[i],
      ),
    );
    const initialHp = new Map(
      army.flatMap((a) => a.map((u) => [u.id, u.hitPoints] as const)),
    );
    while (game.getCurrentTick() < 1800 && !bots.every((b) => b.ready())) {
      if (game.getCurrentTick() % 30 === 0) bots.forEach((b) => b.prepare());
      await game.update();
      if (
        [...initialHp].some(
          ([id, hp]) => (game!.gameApi.getUnitData(id)?.hitPoints ?? 0) < hp,
        )
      )
        throw new Error("Damage during arena preparation");
    }
    if (!bots.every((b) => b.ready()))
      throw new Error("Arena preparation timed out");
    const outsiderCooldown = new Map(
      outsiders.map((u) => [
        u.id,
        game!.gameApi.getUnitData(u.id)?.primaryWeapon?.cooldownTicks ?? 0,
      ]),
    );
    const begin = game.getCurrentTick();
    bots.forEach((b) => b.begin());
    let outcome: "A" | "B" | "U" = "U",
      stop = "time-limit";
    while (game.getCurrentTick() - begin < (options.maxBattleTicks ?? 1800)) {
      const alive = army.map((a) =>
        a
          .map((u) => game!.gameApi.getUnitData(u.id))
          .filter((u) => u && u.hitPoints > 0),
      );
      if (alive.some((a) => !a.length)) {
        outcome = alive[0].length ? "A" : alive[1].length ? "B" : "U";
        stop = "task-elimination";
        break;
      }
      const outside = alive.map((a) =>
        a.some(
          (u) =>
            distance2({ x: u!.tile.rx, y: u!.tile.ry }, center) > radius ** 2,
        ),
      );
      if (outside.some(Boolean)) {
        outcome = outside[0] === outside[1] ? "U" : outside[0] ? "B" : "A";
        stop = "task-boundary";
        break;
      }
      for (const u of outsiders) {
        const actual = game.gameApi.getUnitData(u.id),
          cooldown = actual?.primaryWeapon?.cooldownTicks ?? 0;
        if (
          !actual ||
          actual.hitPoints < u.hp ||
          cooldown > (outsiderCooldown.get(u.id) ?? 0) ||
          distance2({ x: actual.tile.rx, y: actual.tile.ry }, center) <=
            (radius + u.range + 2) ** 2
        )
          throw new Error(
            "Nonparticipant interaction invalidates this arena episode",
          );
        outsiderCooldown.set(u.id, cooldown);
      }
      if (
        (game.getCurrentTick() - begin) % (options.decisionPeriod ?? 15) ===
        0
      )
        bots.forEach((b, i) => {
          const o = b.observe(center, radius, begin),
            decision = options.policies[i].decide(o);
          options.record?.(i, o, decision);
          b.act(o, decision.actions);
        });
      await game.update();
    }
    return {
      protocol: "api-shroud-local-arena-v1",
      task: "eliminate-designated-armor-within-area",
      outcome,
      stop,
      map: options.map,
      tanks: options.tanks,
      preparationTicks: begin,
      battleTicks: game.getCurrentTick() - begin,
      center: { x: center.x, y: center.y },
      radius,
      nativeUnitCount: options.unitCount,
      scope:
        "Local task result, not an ordinary full-game victory; preparation simulation cost included",
    };
  } finally {
    game?.dispose();
  }
}
