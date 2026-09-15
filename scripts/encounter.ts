import {
  cdapi,
  Replay,
  ApiEventType,
  AttackState,
  type UnitData,
} from "@chronodivide/game-api";
import {
  createReadStream,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileHash } from "../src/bot-release.js";
import { combatSignals } from "../src/analysis/combat-signals.js";

const programStart = performance.now();

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    actor: { type: "string" },
    task: { type: "string", default: "regroup-armor" },
  },
});
if (positionals.length !== 1)
  throw new Error(
    "Usage: encounter.ts <run directory> [--actor name] [--task task]",
  );
const directory = resolve(positionals[0]);
const expected = JSON.parse(readFileSync(`${directory}/result.json`, "utf8"));
const manifest = JSON.parse(readFileSync(`${directory}/manifest.json`, "utf8"));
const actor =
  values.actor ??
  manifest.participants.find((p: any) => p.role === "subject").name;
const opponent = expected.stats.find((p: any) => p.name !== actor)?.name;
if (!opponent || !expected.stats.some((p: any) => p.name === actor))
  throw new Error("Actor is not in the recorded roster");
if (fileHash(expected.replay.file) !== expected.replay.sha256)
  throw new Error("Replay hash mismatch");

type Shape = { name: string; x: number; y: number; hp: number };
const signature = (u: Shape) => JSON.stringify([u.name, u.x, u.y, u.hp]);
const signatures = (units: Shape[]) => units.map(signature).sort().join("|");
const sparse = new Map<number, any[]>();
const hints = new Map<number, any[]>();
const commands: any[] = [];
const activity: Record<string, number> = {};
for await (const line of createInterface({
  input: createReadStream(`${directory}/decisions.ndjson`),
  crlfDelay: Infinity,
})) {
  const event = JSON.parse(line);
  if (event.kind === "observation") {
    const list = sparse.get(event.tick) ?? [];
    list.push({
      actor: event.actor,
      own: signatures(event.observation.own),
      enemy: signatures(event.observation.enemies),
    });
    sparse.set(event.tick, list);
  }
  if (event.actor === actor) {
    if (event.kind === "observation" || event.kind === "own_objects_appeared") {
      const list = hints.get(event.tick) ?? [];
      list.push(...(event.observation?.own ?? event.objects));
      hints.set(event.tick, list);
    }
    if (event.kind === "submitted" && "refs" in event.intent) {
      commands.push(event);
      const task = event.intent.task ?? "untagged";
      activity[task] = (activity[task] ?? 0) + 1;
    }
  }
}
const expectedSnapshotChecks = [...sparse.values()].reduce(
  (sum, rows) => sum + rows.length,
  0,
);

type Tank = Shape & {
  id: number;
  maxHp: number;
  attackState?: number;
  canMove?: boolean;
  velocity?: number[];
  weapon?: string;
  minRange?: number;
  maxRange?: number;
  cooldown?: number;
};
type Frame = {
  tick: number;
  own: Tank[];
  opponent: Tank[];
  visibleEnemyIds: number[];
};
const armor = (u: UnitData) => ["MTNK", "HTNK"].includes(u.name);
const shape = (u: UnitData): Shape => ({
  name: u.name,
  x: u.tile.rx,
  y: u.tile.ry,
  hp: u.hitPoints,
});
const tank = (u: UnitData): Tank => ({
  ...shape(u),
  id: u.id,
  maxHp: u.maxHitPoints,
  attackState: u.attackState,
  canMove: u.canMove,
  velocity: u.velocity ? [u.velocity.x, u.velocity.y, u.velocity.z] : undefined,
  weapon: u.primaryWeapon?.rules.name,
  minRange: u.primaryWeapon?.minRange,
  maxRange: u.primaryWeapon?.maxRange,
  cooldown: u.primaryWeapon?.cooldownTicks,
});
const distance = (a: Shape, b: Shape) => Math.hypot(a.x - b.x, a.y - b.y);
const retained = new Map<number, Frame>();
let ring: Frame[] = [],
  activeUntil = -1,
  sampled = 0,
  checked = 0;
const anchors: any[] = [],
  mismatches: any[] = [],
  ambiguousRefs = new Set<string>();
const aliases = new Map<string, number>();
const anchorNames = new Set<string>();
function anchor(kind: string, tick: number, detail: any = {}) {
  if (anchorNames.has(kind)) return;
  anchorNames.add(kind);
  anchors.push({ kind, tick, ...detail });
  activeUntil = Math.max(activeUntil, tick + 300);
  for (const frame of ring)
    if (frame.tick >= tick - 150) retained.set(frame.tick, frame);
}
const replay = Replay.parse(readFileSync(expected.replay.file, "utf8"));
const start = performance.now();
await cdapi.init(resolve(process.env.MIX_DIR ?? "assets/ra2"));
const game = await cdapi.loadReplay(replay);
let focusId: number | undefined,
  focusSeen: number | undefined,
  previous: { tick: number; tank: Tank } | undefined;
const deaths: any[] = [],
  firing: any[] = [],
  damage: any[] = [];
const allFiring: any[] = [];
const previousWeapons = new Map<string, { tick: number; tank: Tank }>();
const known = new Map<number, { id: number; name: string; owner: string }>();
const remember = (id: number) => {
  const u = game.gameApi.getGameObjectData(id);
  if (u?.owner) known.set(id, { id, name: u.name, owner: u.owner });
};
game.gameApi.getAllUnits().forEach(remember);
const unsubscribe = game.eventsApi.subscribe((event) => {
  if (event.type === ApiEventType.ObjectSpawn) remember(event.target);
  if (event.type === ApiEventType.ObjectOwnerChange) {
    const unit = known.get(event.target);
    if (unit) unit.owner = event.newOwnerName;
  }
  if (event.type === ApiEventType.ObjectDestroy) {
    const unit = known.get(event.target);
    if (unit && ["MTNK", "HTNK"].includes(unit.name)) {
      deaths.push({
        tick: game.getCurrentTick(),
        target: unit,
        attacker: event.attackerInfo,
      });
      if (unit.id === focusId)
        anchor("focus_tank_destroyed", game.getCurrentTick(), {
          source: "replay destroy event",
          target: unit,
        });
    }
    known.delete(event.target);
  }
});
const tagged = commands.find((c) => c.intent.task === values.task);
try {
  while (!game.isFinished() && performance.now() - start < 120000) {
    const tick = game.getCurrentTick();
    if (tick % 3 === 0) {
      sampled++;
      const cache = new Map<number, UnitData>();
      const units = (name: string, type: "self" | "enemy") =>
        game
          .getPlayer(name)
          .getVisibleUnits(type)
          .map((id) => {
            if (!cache.has(id)) cache.set(id, game.gameApi.getUnitData(id)!);
            return cache.get(id)!;
          });
      const own = units(actor, "self"),
        visible = units(actor, "enemy");
      for (const snapshot of sparse.get(tick) ?? []) {
        const actualOwn = signatures(units(snapshot.actor, "self").map(shape));
        const actualEnemy = signatures(
          units(snapshot.actor, "enemy").map(shape),
        );
        checked++;
        if (actualOwn !== snapshot.own || actualEnemy !== snapshot.enemy)
          mismatches.push({
            tick,
            actor: snapshot.actor,
            ownMatches: actualOwn === snapshot.own,
            enemyMatches: actualEnemy === snapshot.enemy,
          });
      }
      for (const hint of hints.get(tick) ?? []) {
        const matches = own.filter(
          (u) => signature(shape(u)) === signature(hint),
        );
        if (matches.length === 1) {
          const previousId = aliases.get(hint.ref);
          if (previousId !== undefined && previousId !== matches[0].id)
            ambiguousRefs.add(hint.ref);
          else aliases.set(hint.ref, matches[0].id);
        } else if (matches.length > 1 && !aliases.has(hint.ref))
          ambiguousRefs.add(hint.ref);
      }
      const ownArmor = own.filter(armor).map(tank);
      const enemyArmor = visible.filter(armor).map(tank);
      if (focusId === undefined && ownArmor.length) {
        focusId = ownArmor[0].id;
        focusSeen = tick;
      }
      const frame: Frame = {
        tick,
        own: ownArmor,
        opponent: units(opponent, "self").filter(armor).map(tank),
        visibleEnemyIds: enemyArmor.map((u) => u.id),
      };
      for (const [owner, tanks] of [
        [actor, frame.own],
        [opponent, frame.opponent],
      ] as [string, Tank[]][]) {
        for (const unit of tanks) {
          const key = `${owner}:${unit.id}`;
          const last = previousWeapons.get(key);
          const signal = combatSignals(
            last ? { ...last.tank, tick: last.tick } : undefined,
            { ...unit, tick },
          );
          if (signal.cooldownRestart)
            allFiring.push({
              owner,
              id: unit.id,
              ...signal.cooldownRestart,
            });
          previousWeapons.set(key, { tick, tank: unit });
        }
      }
      ring.push(frame);
      while (ring.length && ring[0].tick < tick - 150) ring.shift();
      const focus = ownArmor.find((u) => u.id === focusId);
      if (focus) {
        const close = enemyArmor.filter((e) => distance(focus, e) < 12);
        if (close.length)
          anchor("first_visible_armor_within_12_tiles", tick, {
            source:
              "sampled team visibility and tile distance; not a firing-range claim",
            ownNearby: ownArmor.filter((u) => distance(u, focus) < 8).length,
            visibleEnemies: close.length,
          });
        const signal = combatSignals(
          previous ? { ...previous.tank, tick: previous.tick } : undefined,
          { ...focus, tick },
        );
        if (signal.damage || signal.cooldownRestart) {
          if (signal.damage) {
            const event = signal.damage;
            damage.push(event);
            anchor("first_focus_hp_decrease", tick, {
              source: "sampled HP; cause unassigned",
              ...event,
            });
          }
          if (signal.cooldownRestart) {
            const event = {
              ...signal.cooldownRestart,
              attackState: focus.attackState,
              stateName:
                focus.attackState === undefined
                  ? undefined
                  : AttackState[focus.attackState],
            };
            firing.push(event);
            anchor("first_focus_cooldown_restart", tick, {
              source:
                "sampled same-weapon cooldown increase; evidence consistent with firing in this interval",
              ...event,
            });
          }
        }
        previous = { tick, tank: focus };
      }
      if (tagged?.tick === tick)
        anchor("first_tagged_order", tick, {
          task: values.task,
          intent: tagged.intent,
          ownArmor: ownArmor.length,
          opponentArmor: frame.opponent.length,
          source:
            "recorded submitted intent plus offline replay state; not causal attribution",
        });
      if (tick <= activeUntil) retained.set(tick, frame);
    }
    await game.update();
  }
  const players = expected.stats.map((p: any) => ({
    name: p.name,
    defeated: game.getPlayer(p.name).isDefeated(),
    credits: game.getPlayer(p.name).getPlayerData().credits,
  }));
  const endMatched =
    game.isFinished() &&
    game.getCurrentTick() === expected.tick &&
    players.every((p: any) =>
      expected.stats.some(
        (e: any) =>
          e.name === p.name &&
          e.defeated === p.defeated &&
          e.credits === p.credits,
      ),
    );
  const focusRefs = [...aliases]
    .filter(([ref, id]) => id === focusId && !ambiguousRefs.has(ref))
    .map(([ref]) => ref);
  const focusOrders = commands
    .filter((c) => c.intent.refs.some((ref: string) => focusRefs.includes(ref)))
    .map((c) => ({
      tick: c.tick,
      kind: c.intent.kind,
      task: c.intent.task,
      target: c.intent.target,
      x: c.intent.x,
      y: c.intent.y,
    }));
  const frames = [...retained.values()].sort((a, b) => a.tick - b.tick);
  const text = frames.map((f) => JSON.stringify(f)).join("\n") + "\n";
  const report = {
    scope:
      "offline factual replay reconstruction; no policy calls, no alternative-action outcomes",
    informationBoundary:
      "weapon/attack inspection and opponent-owned state are diagnostic only, never fed to actors",
    source: {
      directory,
      replaySha256: expected.replay.sha256,
      gameTimestamp: replay.gameTimestamp,
      actor,
      opponent,
      task: values.task,
      policyReleases: manifest.participants,
    },
    verification: {
      endMatched,
      endTick: game.getCurrentTick(),
      players,
      sparseSnapshotFields: ["name", "tile x/y", "hit points"],
      sparseSnapshotsExpected: expectedSnapshotChecks,
      sparseSnapshotsChecked: checked,
      mismatches,
    },
    focus: { id: focusId, firstSeenTick: focusSeen, refs: focusRefs },
    anchors,
    focusOrders,
    firingIntervals: firing,
    allArmorFiringIntervals: allFiring,
    damageIntervals: damage,
    armorDestructions: deaths,
    taskActivity: activity,
    ambiguousRefs: [...ambiguousRefs],
    cost: {
      wallSeconds: (performance.now() - start) / 1000,
      totalSeconds: (performance.now() - programStart) / 1000,
      sampledFrames: sampled,
      retainedFrames: frames.length,
      tickInterval: 3,
      beforeTicks: 150,
      afterTicks: 300,
      windowBytes: Buffer.byteLength(text),
      originalTraceBytes: statSync(`${directory}/decisions.ndjson`).size,
    },
  };
  writeFileSync(`${directory}/encounter.json`, JSON.stringify(report, null, 2));
  if (!endMatched || mismatches.length || checked !== expectedSnapshotChecks)
    throw new Error(
      `Replay reconstruction failed validation; inspect ${directory}/encounter.json`,
    );
  writeFileSync(`${directory}/encounter-frames.ndjson`, text);
  const lines = [
    "# 首车接敌分析",
    "",
    `对象：${actor}；数据来自原始回放重建，每 3 tick 采样。`,
    "",
    `原单位名称/位置/血量快照核对 ${checked} 次，终局、资金和败北状态匹配。武器状态与对手私有状态仅供诊断。`,
    "",
    "| 事件 | tick | 证据范围 |",
    "| --- | ---: | --- |",
    ...anchors.map((a) => `| ${a.kind} | ${a.tick} | ${a.source} |`),
    "",
    `所选任务 ${values.task}：${activity[values.task!] ?? 0} 条已标记新指令；没有记录不等于已经证明该能力无用。`,
    "",
    `保留 ${frames.length}/${sampled} 帧；窗口 ${(Buffer.byteLength(text) / 1024).toFixed(1)} KiB；重建 ${report.cost.wallSeconds.toFixed(2)} 秒。`,
    "",
    "HP 变化与冷却重启定位到采样区间；销毁事件保留引擎 tick。范围内单位数量不等于实际开火数量。",
    "具体位置、冷却和攻击状态见 encounter-frames.ndjson；命令与事件见 encounter.json。",
    "",
  ];
  writeFileSync(`${directory}/encounter.md`, lines.join("\n"));
  console.log(
    JSON.stringify({
      verified: true,
      focus: report.focus,
      anchors,
      cost: report.cost,
      report: `${directory}/encounter.md`,
    }),
  );
} finally {
  unsubscribe();
  game.dispose();
}
