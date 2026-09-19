import type { Observation, Point, Intent } from "../model.js";
import type { StrategicPlan } from "../control/contracts.js";
import { combatSignals } from "./combat-signals.js";

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const isArmor = (name: string) => ["MTNK", "HTNK", "SREF"].includes(name);
export const clockTime = (tick: number) =>
  `${Math.floor(tick / 900)}:${String(Math.floor((tick % 900) / 15)).padStart(2, "0")}`;

export interface StalledMarch {
  fromTick: number;
  toTick: number;
  units: number;
  task: string;
  destination: Point;
  position: Point;
  moveOrders: number;
}

/** Plans and submitted orders are intentions; only observed positions establish movement. */
export class JournalBehavior {
  planCount = 0;
  firstAdvance?: { tick: number; units: number; destination?: Point };
  firstAdvanceOutsideHome?: number;
  advanceMoveOrders = 0;
  advanceCombatOrders = 0;
  firstEnemyBuilding?: number;
  firstEnemyMcv?: number;
  firstScoutOrder?: number;
  private contactEvents = false;
  private waiting?: {
    fromTick: number;
    toTick: number;
    minArmor: number;
    maxArmor: number;
    reason: string;
  };
  private longestWait?: NonNullable<JournalBehavior["waiting"]>;
  private decisionReason?: string;
  private plan?: StrategicPlan;
  private segment?: StalledMarch & {
    key: string;
    positions: Map<string, Point>;
  };
  private stalls: StalledMarch[] = [];
  private moveTicks: { tick: number; task: string }[] = [];
  readonly taskOrders = new Map<string, { count: number; firstTick: number }>();

  onPlan(plan: StrategicPlan) {
    this.plan = plan;
    this.planCount++;
    if (
      !this.firstAdvance &&
      plan.combat.kind === "advance" &&
      plan.combat.units.length
    )
      this.firstAdvance = {
        tick: plan.tick,
        units: plan.combat.units.length,
        destination: plan.combat.groundDestination ?? plan.combat.destination,
      };
  }

  onOrder(tick: number, intent: Intent, originId?: string) {
    const owner = originId ?? intent.task;
    if (owner?.startsWith("recon") && intent.kind === "move")
      this.firstScoutOrder ??= tick;
    for (const name of new Set(
      [originId, intent.task].filter((s): s is string => !!s),
    )) {
      const task = this.taskOrders.get(name) ?? {
        count: 0,
        firstTick: tick,
      };
      task.count++;
      this.taskOrders.set(name, task);
    }
    const advancing =
      this.plan?.combat.kind === "advance" && owner === this.plan.combat.id;
    if (
      advancing &&
      ["move", "attackMove", "attack", "crush"].includes(intent.kind)
    )
      this.advanceCombatOrders++;
    if (intent.kind === "move" || intent.kind === "attackMove") {
      this.moveTicks.push({ tick, task: owner ?? "" });
      if (advancing) this.advanceMoveOrders++;
    }
  }

  onDecision(facts: Readonly<Record<string, unknown>>) {
    this.decisionReason = String(
      facts.operationReason ?? facts.objective ?? "unknown",
    );
    if (this.waiting) this.waiting.reason = this.decisionReason;
  }

  onContact(tick: number, contacts: readonly { type: number; name: string }[]) {
    this.contactEvents = true;
    if (contacts.some((e) => e.type === 2)) this.firstEnemyBuilding ??= tick;
    if (contacts.some((e) => ["AMCV", "SMCV"].includes(e.name)))
      this.firstEnemyMcv ??= tick;
  }

  private finishWait() {
    const wait = this.waiting;
    if (
      wait &&
      wait.toTick - wait.fromTick >= 900 &&
      (!this.longestWait ||
        wait.toTick - wait.fromTick >
          this.longestWait.toTick - this.longestWait.fromTick)
    )
      this.longestWait = { ...wait };
    this.waiting = undefined;
  }

  private finishSegment() {
    const s = this.segment;
    if (s && s.toTick - s.fromTick >= 900) {
      const { positions: _, key: _key, ...stall } = s;
      stall.moveOrders = this.moveTicks.filter(
        (o) => o.task === s.task && o.tick >= s.fromTick && o.tick <= s.toTick,
      ).length;
      if (stall.moveOrders > 1) this.stalls.push(stall);
    }
    this.segment = undefined;
  }

  onObservation(o: Observation) {
    const mission = this.plan?.combat;
    if (o.enemies.some((u) => u.type === 2)) this.firstEnemyBuilding ??= o.tick;
    if (o.enemies.some((u) => ["AMCV", "SMCV"].includes(u.name)))
      this.firstEnemyMcv ??= o.tick;
    const armor = o.own.filter((u) => isArmor(u.name)).length;
    const nearbyThreat = o.enemies.some(
      (e) =>
        ((e.weaponRange ?? 1) > 0 || e.canThreatenBuildings) &&
        o.own.some(
          (u) =>
            (u.type === 2 || u.harvester) &&
            (u.type === 2
              ? e.canThreatenBuildings !== false
              : e.canThreatenVehicles !== false) &&
            distance(e, {
              x: Math.max(u.x, Math.min(e.x, u.x + u.width)),
              y: Math.max(u.y, Math.min(e.y, u.y + u.height)),
            }) <= 10,
        ),
    );
    if (mission && mission.kind !== "advance" && armor >= 4 && !nearbyThreat) {
      if (this.waiting && o.tick - this.waiting.toTick > 300) this.finishWait();
      this.waiting ??= {
        fromTick: o.tick,
        toTick: o.tick,
        minArmor: armor,
        maxArmor: armor,
        reason: this.decisionReason ?? mission.objective,
      };
      this.waiting.toTick = o.tick;
      this.waiting.minArmor = Math.min(this.waiting.minArmor, armor);
      this.waiting.maxArmor = Math.max(this.waiting.maxArmor, armor);
    } else this.finishWait();
    const target = mission?.groundDestination ?? mission?.destination;
    const force = o.own.filter(
      (u) => isArmor(u.name) && mission?.units.includes(u.ref),
    );
    if (mission?.kind !== "advance" || !target || force.length < 2) {
      this.finishSegment();
      return;
    }
    if (
      this.firstAdvanceOutsideHome === undefined &&
      force.some((u) => distance(u, o.home) > 12)
    )
      this.firstAdvanceOutsideHome = o.tick;
    // A stationary force at its destination is not a failed march.
    if (force.some((u) => distance(u, target) <= 2)) {
      this.finishSegment();
      return;
    }
    const key = JSON.stringify([mission.id, target.x, target.y]);
    const s = this.segment;
    const continuing = s ? force.filter((u) => s.positions.has(u.ref)) : [];
    if (
      s &&
      s.key === key &&
      o.tick - s.toTick <= 300 &&
      continuing.length >= Math.max(2, Math.ceil(s.positions.size * 0.7)) &&
      continuing.every((u) => distance(u, s.positions.get(u.ref)!) <= 1)
    ) {
      s.toTick = o.tick;
      s.units = Math.min(s.units, continuing.length);
    } else {
      this.finishSegment();
      this.segment = {
        key,
        fromTick: o.tick,
        toTick: o.tick,
        task: mission.id,
        units: force.length,
        destination: target,
        moveOrders: 0,
        position: {
          x: force.reduce((n, u) => n + u.x, 0) / force.length,
          y: force.reduce((n, u) => n + u.y, 0) / force.length,
        },
        positions: new Map(force.map((u) => [u.ref, { x: u.x, y: u.y }])),
      };
    }
  }

  finish() {
    this.finishSegment();
    this.finishWait();
    return {
      firstEnemyBuilding: this.firstEnemyBuilding,
      firstEnemyMcv: this.firstEnemyMcv,
      firstScoutOrder: this.firstScoutOrder,
      contactTiming: this.contactEvents ? "contact-events" : "periodic-samples",
      longestQuietWait: this.longestWait
        ? {
            ...this.longestWait,
            scoutMoveOrders: this.moveTicks.filter(
              (m) =>
                m.task.startsWith("recon") &&
                m.tick >= this.longestWait!.fromTick &&
                m.tick <= this.longestWait!.toTick,
            ).length,
          }
        : undefined,
      plansRecorded: this.planCount,
      firstAdvance: this.firstAdvance,
      advanceMoveOrders: this.advanceMoveOrders,
      advanceCombatOrders: this.advanceCombatOrders,
      firstAdvanceOutsideHome: this.firstAdvanceOutsideHome,
      longestStalledMarch: this.stalls.sort(
        (a, b) => b.toTick - b.fromTick - (a.toTick - a.fromTick),
      )[0],
    };
  }
}

export interface ReplayUnit extends Point {
  id: number;
  name: string;
  hp: number;
  building: boolean;
  defense: boolean;
  infantry: boolean;
  armor: boolean;
  combat: boolean;
  airborne: boolean;
  deployed: boolean;
  range: number;
  width: number;
  height: number;
  weapons: { name: string; cooldown: number }[];
}
export interface BehaviorFrame {
  tick: number;
  own: ReplayUnit[];
  opponent: ReplayUnit[];
  visibleEnemyIds: number[];
}
interface DefenseWindow {
  fromTick: number;
  toTick: number;
  firstDamageTick?: number;
  lastDamageTick?: number;
  hpDecrease: number;
  buildings: Set<string>;
  infantryMin: number;
  infantryMax: number;
  deployedMax: number;
  geometricRangeMax: number;
  firingIds: Set<number>;
  peakFiringUnitsIn30Ticks: number;
  firingSamples: number;
  firingUnitSamples: number;
}

/** Streaming replay facts. Controller labels do not establish successful behavior. */
export class ReplayBehavior {
  private previous = new Map<string, { tick: number; unit: ReplayUnit }>();
  private defenseWindow?: DefenseWindow;
  private defenseWindows: DefenseWindow[] = [];
  private recentInfantryFire = new Map<number, number>();
  private armorFireTicks: number[] = [];
  private nonDefenseDamage = { own: 0, opponent: 0 };
  private nonDefenseDestroyed = { own: 0, opponent: 0 };
  private finalOwn: ReplayUnit[] = [];
  private firstOpponentStructureDamage?: number;
  private deployments = new Map<
    number,
    { fromTick: number; fireSignals: number }
  >();
  private shortDeployments = {
    count: 0,
    examples: [] as {
      fromTick: number;
      toTick: number;
      nearbyVisibleEnemies: number;
    }[],
  };
  private ownDestroyed: Record<string, number> = {};
  private buildingLossWindows = new Set<number>();
  private armorLosses: {
    tick: number;
    nearestFriendlyArmorDistance: number | null;
  }[] = [];

  destroyed(
    side: "own" | "opponent",
    unit: { building: boolean; defense: boolean; id?: number; name?: string },
    tick?: number,
  ) {
    if (unit.building && !unit.defense) this.nonDefenseDestroyed[side]++;
    if (side === "own" && unit.name) {
      this.ownDestroyed[unit.name] = (this.ownDestroyed[unit.name] ?? 0) + 1;
      if (unit.building && tick !== undefined)
        this.buildingLossWindows.add(Math.floor(tick / 450));
      const previous = this.previous.get(`own:${unit.id}`);
      if (
        isArmor(unit.name) &&
        previous &&
        tick !== undefined &&
        tick - previous.tick <= 3
      ) {
        const distances = this.finalOwn
          .filter((u) => u.armor && u.id !== unit.id)
          .map((u) => distance(u, previous.unit));
        if (this.armorLosses.length < 3)
          this.armorLosses.push({
            tick,
            nearestFriendlyArmorDistance: distances.length
              ? Math.round(Math.min(...distances) * 10) / 10
              : null,
          });
      }
      this.finalOwn = this.finalOwn.filter((u) => u.id !== unit.id);
      if (unit.id !== undefined) this.deployments.delete(unit.id);
    }
  }

  sample(frame: BehaviorFrame) {
    const { tick } = frame;
    const infantryFired: number[] = [];
    const damaged: { unit: ReplayUnit; decrease: number }[] = [];
    for (const side of ["own", "opponent"] as const) {
      for (const unit of frame[side]) {
        const key = `${side}:${unit.id}`;
        const previous = this.previous.get(key);
        if (previous && tick - previous.tick === 3) {
          const decrease = previous.unit.hp - unit.hp;
          if (unit.building && decrease > 0) {
            if (!unit.defense) this.nonDefenseDamage[side] += decrease;
            if (side === "opponent" && !unit.defense)
              this.firstOpponentStructureDamage ??= tick;
            if (side === "own") damaged.push({ unit, decrease });
          }
          const fired = unit.weapons.some((weapon) => {
            const old = previous.unit.weapons.find(
              (w) => w.name === weapon.name,
            );
            return (
              old &&
              combatSignals(
                {
                  tick: previous.tick,
                  id: unit.id,
                  hp: previous.unit.hp,
                  weapon: old.name,
                  cooldown: old.cooldown,
                },
                {
                  tick,
                  id: unit.id,
                  hp: unit.hp,
                  weapon: weapon.name,
                  cooldown: weapon.cooldown,
                },
              ).cooldownRestart
            );
          });
          if (side === "own" && fired) {
            if (unit.armor) this.armorFireTicks.push(tick);
            if (unit.infantry) {
              infantryFired.push(unit.id);
              this.recentInfantryFire.set(unit.id, tick);
            }
          }
          if (side === "own" && unit.infantry && unit.combat) {
            if (unit.deployed && !previous.unit.deployed)
              this.deployments.set(unit.id, { fromTick: tick, fireSignals: 0 });
            const episode = this.deployments.get(unit.id);
            if (episode && fired) episode.fireSignals++;
            if (!unit.deployed && previous.unit.deployed) {
              if (
                episode &&
                !episode.fireSignals &&
                tick - episode.fromTick <= 150
              ) {
                this.shortDeployments.count++;
                if (this.shortDeployments.examples.length < 3)
                  this.shortDeployments.examples.push({
                    fromTick: episode.fromTick,
                    toTick: tick,
                    nearbyVisibleEnemies: frame.opponent.filter(
                      (e) =>
                        frame.visibleEnemyIds.includes(e.id) &&
                        e.combat &&
                        !e.airborne &&
                        distance(e, previous.unit) <= previous.unit.range,
                    ).length,
                  });
              }
              this.deployments.delete(unit.id);
            }
          }
        }
        this.previous.set(key, { tick, unit });
      }
    }
    const visible = new Set(frame.visibleEnemyIds);
    const threats = frame.opponent.filter(
      (u) => visible.has(u.id) && u.combat && !u.airborne,
    );
    const nearDamagedBuilding = damaged.some(({ unit: b }) =>
      threats.some((e) => {
        const nearest = {
          x: Math.max(b.x, Math.min(e.x, b.x + b.width)),
          y: Math.max(b.y, Math.min(e.y, b.y + b.height)),
        };
        return distance(e, nearest) <= e.range + 1;
      }),
    );
    // Fixed half-minute windows keep early non-participation visible even if defenders
    // eventually fire after the attack reaches their old posts.
    if (
      this.defenseWindow &&
      Math.floor(tick / 450) !== Math.floor(this.defenseWindow.fromTick / 450)
    )
      this.finishDefense();
    const infantry = frame.own.filter((u) => u.infantry && u.combat);
    if (!this.defenseWindow) {
      this.defenseWindow = {
        fromTick: tick,
        toTick: tick,
        hpDecrease: 0,
        buildings: new Set(),
        infantryMin: infantry.length,
        infantryMax: infantry.length,
        deployedMax: 0,
        geometricRangeMax: 0,
        firingIds: new Set(),
        peakFiringUnitsIn30Ticks: 0,
        firingSamples: 0,
        firingUnitSamples: 0,
      };
    }
    const window = this.defenseWindow;
    if (window) {
      window.toTick = tick;
      if (nearDamagedBuilding) {
        window.firstDamageTick ??= tick;
        window.lastDamageTick = tick;
        for (const { unit, decrease } of damaged) {
          window.hpDecrease += decrease;
          window.buildings.add(unit.name);
        }
      }
      window.infantryMin = Math.min(window.infantryMin, infantry.length);
      window.infantryMax = Math.max(window.infantryMax, infantry.length);
      window.deployedMax = Math.max(
        window.deployedMax,
        infantry.filter((u) => u.deployed).length,
      );
      window.geometricRangeMax = Math.max(
        window.geometricRangeMax,
        infantry.filter((u) => threats.some((e) => distance(u, e) <= u.range))
          .length,
      );
      infantryFired.forEach((id) => window.firingIds.add(id));
      const firing = infantry.filter(
        (u) => tick - (this.recentInfantryFire.get(u.id) ?? -Infinity) <= 30,
      ).length;
      window.peakFiringUnitsIn30Ticks = Math.max(
        window.peakFiringUnitsIn30Ticks,
        firing,
      );
      window.firingSamples++;
      window.firingUnitSamples += firing;
    }
    this.finalOwn = frame.own;
  }

  private finishDefense() {
    if (this.defenseWindow?.hpDecrease)
      this.defenseWindows.push(this.defenseWindow);
    this.defenseWindow = undefined;
  }

  finish(
    journal: ReturnType<JournalBehavior["finish"]>,
    finalOwn = this.finalOwn,
  ) {
    this.finishDefense();
    const candidates = this.defenseWindows.filter(
      (w) =>
        w.infantryMin > 0 &&
        w.firstDamageTick !== undefined &&
        w.lastDamageTick !== undefined &&
        (w.lastDamageTick - w.firstDamageTick >= 150 ||
          this.buildingLossWindows.has(Math.floor(w.fromTick / 450))),
    );
    const noFire = (w: DefenseWindow) =>
      !w.firingIds.size && !w.peakFiringUnitsIn30Ticks;
    // Surface the first missed engagement, not late damage after the defense has collapsed.
    const defense = candidates.sort(
      (a, b) =>
        Number(noFire(b)) - Number(noFire(a)) || a.fromTick - b.fromTick,
    )[0];
    const stall = journal.longestStalledMarch;
    return {
      ...journal,
      shortInfantryDeploymentsWithoutFire: this.shortDeployments,
      ownDestructionEvents: this.ownDestroyed,
      firstArmorLosses: this.armorLosses,
      longestStalledMarch: stall
        ? {
            ...stall,
            ownArmorFireSignals: this.armorFireTicks.filter(
              (t) => t >= stall.fromTick && t <= stall.toTick,
            ).length,
          }
        : undefined,
      opponentNonDefenseBuildings: {
        observedHpDecrease: this.nonDefenseDamage.opponent,
        destructionEvents: this.nonDefenseDestroyed.opponent,
        firstObservedHpDecrease: this.firstOpponentStructureDamage,
      },
      defenseWindow: defense
        ? {
            ...defense,
            buildings: [...defense.buildings],
            firingIds: undefined,
            infantryWithFiringSignals: defense.firingIds.size,
          }
        : undefined,
      finalOwn: finalOwn.reduce<Record<string, number>>((out, u) => {
        out[u.name] = (out[u.name] ?? 0) + 1;
        return out;
      }, {}),
    };
  }
}

export function renderBehavior(b: ReturnType<ReplayBehavior["finish"]>) {
  const lines: string[] = [];
  lines.push(
    `- 情报：${b.firstScoutOrder === undefined ? "未记录独立侦察移动" : `首次侦察移动指令 ${clockTime(b.firstScoutOrder)}`}；首次记录敌建筑 ${b.firstEnemyBuilding === undefined ? "未记录" : clockTime(b.firstEnemyBuilding)}，基地车 ${b.firstEnemyMcv === undefined ? "未记录" : clockTime(b.firstEnemyMcv)}。接触时间来源：${b.contactTiming === "contact-events" ? "合法观察接触事件" : "周期采样（可能晚于实际发现）"}；不作侦察单位归因。`,
  );
  lines.push(
    b.firstAdvance
      ? `- 进攻计划：${clockTime(b.firstAdvance.tick)}，${b.firstAdvance.units} 个单位；该阶段提交 ${b.advanceCombatOrders} 条主力作战命令，其中移动 ${b.advanceMoveOrders} 条。`
      : b.plansRecorded
        ? "- 进攻计划：全段任务日志中未出现有兵力的主力 advance 任务。"
        : "- 进攻计划：该版本没有记录战略任务，无法从日志判断。",
  );
  if (b.firstAdvanceOutsideHome !== undefined)
    lines.push(
      `- 实际位移：${clockTime(b.firstAdvanceOutsideHome)} 已采样到进攻主力坦克离开基地 12 格范围；这不等于已攻击敌方基地。`,
    );
  const waiting = b.longestQuietWait;
  if (waiting)
    lines.push(
      `- 未推进时段：${clockTime(waiting.fromTick)}–${clockTime(waiting.toTick)}，持有 ${waiting.minArmor}–${waiting.maxArmor} 辆坦克，未记录近处建筑/矿车威胁；侦察移动指令 ${waiting.scoutMoveOrders} 条，最近决策理由 ${waiting.reason}。需检查集结、情报与风险，不能单凭等待判错。`,
    );
  const s = b.longestStalledMarch;
  if (s)
    lines.push(
      `- 行军停滞：${clockTime(s.fromTick)}–${clockTime(s.toTick)}，${s.units} 辆主力坦克的采样位置始终在原处 1 格内，目标尚未到达；期间提交 ${s.moveOrders} 条移动命令，我方坦克开火信号 ${s.ownArmorFireSignals} 次。`,
    );
  const e = b.opponentNonDefenseBuildings;
  lines.push(
    `- 敌方非防御建筑：记录到 HP 下降 ${e.observedHpDecrease}、摧毁事件 ${e.destructionEvents}。${e.firstObservedHpDecrease !== undefined ? `首次掉血 ${clockTime(e.firstObservedHpDecrease)}。` : ""}（损伤未做攻击者归因。）`,
  );
  const d = b.defenseWindow;
  lines.push(
    d
      ? `- 防守参与：${clockTime(d.fromTick)}–${clockTime(d.toTick)}，${d.buildings.join("/")} 掉血 ${d.hpDecrease}，可见地面威胁在附近；己方战斗步兵 ${d.infantryMin}–${d.infantryMax} 名，${d.infantryWithFiringSignals} 名有开火信号。两秒窗开火人数平均 ${(d.firingUnitSamples / Math.max(1, d.firingSamples)).toFixed(1)}、峰值 ${d.peakFiringUnitsIn30Ticks}；包括接敌/转场时段，几何射程内最多 ${d.geometricRangeMax} 名。`
      : "- 防守参与：未找到存在己方步兵及近处可见地面威胁的持续受损或建筑损失窗口；不据此判定防守有效。",
  );
  const churn = b.shortInfantryDeploymentsWithoutFire;
  const canceled = churn.examples
    .map(
      (e) =>
        `${clockTime(e.fromTick)} 起 ${(e.toTick - e.fromTick) / 15} 秒，解除时附近可见敌军 ${e.nearbyVisibleEnemies}`,
    )
    .join("；");
  lines.push(
    `- 步兵部署后十秒内无开火信号便解除：${churn.count} 次。${canceled ? `${canceled}。这些是回看线索，不能单独判定改派错误。` : ""}`,
  );
  const losses = b.firstArmorLosses
    .map(
      (e) =>
        `${clockTime(e.tick)} 坦克被毁时，最近友军坦克 ${e.nearestFriendlyArmorDistance === null ? "无" : `${e.nearestFriendlyArmorDistance} 格`}`,
    )
    .join("；");
  lines.push(
    `- 己方摧毁事件：${
      Object.entries(b.ownDestructionEvents)
        .map(([name, count]) => `${name}×${count}`)
        .join("、") || "无"
    }。${losses ? `${losses}。` : ""}`,
  );
  lines.push(
    `- 停止时己方：${
      Object.entries(b.finalOwn)
        .map(([name, n]) => `${name}×${n}`)
        .join("、") || "无单位"
    }。`,
  );
  return lines.join("\n");
}
