import {
  Bot,
  ObjectType,
  OrderType,
  QueueStatus,
  type GameApi,
  type UnitData,
} from "@chronodivide/game-api";
import { Commander, type PolicyMode } from "./policy.js";
import {
  rememberIntent,
  observedEffect,
  type PendingEffect,
} from "./effects.js";
import {
  distance2,
  type Observation,
  type Intent,
  type Unit,
  type Point,
} from "./model.js";

export const OBSERVATION_PROTOCOL = "api-shroud-v0-visible-placement-frontier";
export interface Trace {
  tick: number;
  actor: string;
  kind: string;
  [key: string]: unknown;
}

/** The only module that can query the engine or submit actions for this actor. */
export class WarbookBot extends Bot {
  private readonly commander: Commander;
  private nativeToRef = new Map<number, string>();
  private currentRefs = new Map<string, number>();
  private sequence = 0;
  private lastObservation?: Observation;
  private lastSnapshotTick = -150;
  private intentSequence = 0;
  private pendingEffects: PendingEffect[] = [];
  private scoutPoints: readonly Point[] = [];
  private lastScoutScan = -150;
  private lastControlReportTick = -150;
  private lastCombatRevision = -1;
  private lastProductionRevision = -1;
  public trace?: (event: Trace) => void;
  public autoTick = false;
  public observation?: Observation;
  constructor(
    name: string,
    country = "Americans",
    readonly mode: PolicyMode = "baseline",
  ) {
    super(name, country);
    this.commander = new Commander(mode);
  }
  override onGameTick(game: GameApi): void {
    if (
      this.autoTick &&
      game.getCurrentTick() % 3 === 0 &&
      !this.player.isDefeated()
    ) {
      this.submit(this.decide(this.observe()));
    }
  }
  private sorted(ids: number[]): UnitData[] {
    return ids
      .map((id) => this.game.getUnitData(id))
      .filter((u): u is UnitData => !!u)
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          a.tile.rx - b.tile.rx ||
          a.tile.ry - b.tile.ry ||
          a.hitPoints - b.hitPoints,
      );
  }
  private ref(u: UnitData): string {
    let ref = this.nativeToRef.get(u.id);
    if (!ref) {
      ref = "entity-" + this.sequence++;
      this.nativeToRef.set(u.id, ref);
    }
    this.currentRefs.set(ref, u.id);
    return ref;
  }
  observe(): Observation {
    this.currentRefs.clear();
    const data = this.player.getPlayerData();
    const tick = this.game.getCurrentTick();
    if (tick - this.lastScoutScan >= 150) {
      const size = this.game.map.getRealMapSize();
      const points: Point[] = [];
      for (let x = 4; x < size.width; x += 8)
        for (let y = 4; y < size.height; y += 8) {
          const tile = this.game.map.getTile(x, y);
          // Static map domain and our own shroud only, without unseen terrain or occupancy queries.
          if (tile && !this.game.map.isVisibleTile(tile, this.name))
            points.push(Object.freeze({ x, y }));
        }
      this.scoutPoints = Object.freeze(points);
      this.lastScoutScan = tick;
    }
    const own = this.sorted(this.player.getVisibleUnits("self")).map(
      (u): Unit => ({
        ref: this.ref(u),
        name: u.name,
        type: u.type,
        x: u.tile.rx,
        y: u.tile.ry,
        hp: u.hitPoints,
        maxHp: u.maxHitPoints,
        width: u.foundation.width,
        height: u.foundation.height,
        mobile: !!u.canMove,
        idle: !!u.isIdle,
        harvester: u.rules.harvester,
        mcv: !!u.rules.deploysInto && !u.rules.harvester,
        yard: u.rules.constructionYard,
        refinery: u.rules.refinery,
        combat: u.rules.isSelectableCombatant,
        buildStatus: u.buildStatus,
        deployed: u.stance === 3,
        crusher: u.rules.crusher,
        antiAir: !!(
          u.primaryWeapon?.projectileRules.isAntiAir ||
          u.secondaryWeapon?.projectileRules.isAntiAir
        ),
      }),
    );
    const enemies = this.sorted(this.player.getVisibleUnits("enemy")).map(
      (u) => ({
        ref: this.ref(u),
        name: u.name,
        type: u.type,
        x: u.tile.rx,
        y: u.tile.ry,
        hp: u.hitPoints,
        maxHp: u.maxHitPoints,
        observedTick: tick,
        airborne: u.zone === 1,
      }),
    );
    const products = this.player.production.getAvailableObjects().map((p) => ({
      name: p.name,
      type: p.type,
      cost: p.cost,
      queue: this.player.production.getQueueTypeForObject(p),
    }));
    const queues = [0, 1, 2, 3, 4, 5]
      .map((type) => this.player.production.getQueueData(type))
      .map((q) => ({
        type: q.type,
        status: q.status,
        size: q.size,
        items: q.items.map((i) => ({
          name: i.rules.name,
          quantity: i.quantity,
        })),
      }));
    const buildSites: Observation["buildSites"] = [];
    for (const q of queues.filter(
      (q) => q.status === QueueStatus.Ready && (q.type === 0 || q.type === 1),
    )) {
      const name = q.items[0]?.name;
      if (!name) continue;
      const { foundation } = this.game.getBuildingPlacementData(name);
      const candidates = new Map<string, { x: number; y: number }>();
      for (const b of own.filter((u) => u.type === ObjectType.Building)) {
        for (let x = b.x - 7; x <= b.x + b.width + 7; x++)
          for (let y = b.y - 7; y <= b.y + b.height + 7; y++) {
            if (
              x < b.x + b.width + 1 &&
              x + foundation.width > b.x - 1 &&
              y < b.y + b.height + 1 &&
              y + foundation.height > b.y - 1
            )
              continue;
            candidates.set(`${x},${y}`, { x, y });
          }
      }
      const home = { x: data.startLocation.x, y: data.startLocation.y };
      const enemy = enemies
        .slice()
        .sort((a, b) => distance2(a, home) - distance2(b, home))[0];
      const anchor =
        this.game.rules.getBuilding(name).isBaseDefense && enemy ? enemy : home;
      for (const p of [...candidates.values()].sort(
        (a, b) =>
          distance2(a, anchor) - distance2(b, anchor) || a.x - b.x || a.y - b.y,
      )) {
        let visible = true;
        for (let x = p.x; x < p.x + foundation.width; x++)
          for (let y = p.y; y < p.y + foundation.height; y++) {
            const tile = this.game.map.getTile(x, y);
            if (!tile || !this.game.map.isVisibleTile(tile, this.name))
              visible = false;
          }
        if (!visible) continue;
        const tile = this.game.map.getTile(p.x, p.y)!;
        if (this.player.canPlaceBuilding(name, tile)) {
          buildSites.push({ name, ...p });
          break;
        }
      }
    }
    const observation: Observation = {
      tick,
      side: data.country!.side,
      credits: data.credits,
      power: {
        total: data.power.total,
        drain: data.power.drain,
        isLowPower: data.power.isLowPower,
      },
      home: { x: data.startLocation.x, y: data.startLocation.y },
      starts: this.game.map
        .getStartingLocations()
        .map((p) => ({ x: p.x, y: p.y })),
      own,
      enemies,
      products,
      queues,
      buildSites,
      scoutPoints: this.scoutPoints,
      scoutObservedTick: this.lastScoutScan,
    };
    if (this.lastObservation) {
      const before = new Set(this.lastObservation.own.map((u) => u.ref));
      const appeared = own.filter((u) => !before.has(u.ref));
      if (appeared.length)
        this.trace?.({
          tick,
          actor: this.name,
          kind: "own_objects_appeared",
          objects: appeared,
        });
    }
    if (tick - this.lastSnapshotTick >= 150) {
      this.trace?.({
        tick,
        actor: this.name,
        kind: "observation",
        observation,
      });
      this.lastSnapshotTick = tick;
    }
    this.lastObservation = this.observation = observation;
    this.pendingEffects = this.pendingEffects.filter((p) => {
      const effect = observedEffect(p, observation);
      const expired = tick - p.tick >= 450;
      if ((effect || expired) && p.origin)
        this.commander.acceptEffect({
          origin: p.origin,
          intentId: p.id,
          basedOnTick: p.tick,
          observedTick: tick,
          effect,
          unresolved: !effect,
        });
      if (effect || expired)
        this.trace?.({
          tick,
          actor: this.name,
          kind: effect ? "effect_observed" : "effect_unresolved",
          intentId: p.id,
          basedOnTick: p.tick,
          effect,
          source: "player_observation",
        });
      return !effect && !expired;
    });
    return observation;
  }
  decide(observation: Observation): Intent[] {
    return this.commander.decide(observation);
  }
  submit(intents: Intent[]): void {
    const o = this.observation;
    if (!o || o.tick !== this.game.getCurrentTick())
      throw new Error("Stale observation");
    const plan = this.commander.controlPlan;
    if (plan && plan.tick !== o.tick) throw new Error("Stale control decision");
    if (
      plan &&
      (plan.combat.revision !== this.lastCombatRevision ||
        plan.production.revision !== this.lastProductionRevision)
    ) {
      this.trace?.({
        tick: o.tick,
        actor: this.name,
        kind: "strategic_plan",
        plan,
      });
      this.lastCombatRevision = plan.combat.revision;
      this.lastProductionRevision = plan.production.revision;
    }
    const report = this.commander.controlReport;
    if (report && o.tick - this.lastControlReportTick >= 150) {
      this.trace?.({
        tick: o.tick,
        actor: this.name,
        kind: "control_report",
        report,
      });
      this.lastControlReportTick = o.tick;
    }
    const owned = new Set(o.own.map((u) => u.ref));
    const visible = new Set(o.enemies.map((u) => u.ref));
    const assigned = new Set<string>();
    const changedQueues = new Set<number>();
    for (const intent of intents) {
      this.commander.assertCurrentIntent(intent, o.tick);
      if (
        "refs" in intent &&
        intent.refs.some((ref) => !owned.has(ref) || assigned.has(ref))
      )
        throw new Error("Conflicting or unavailable actor");
      const ids =
        "refs" in intent
          ? intent.refs.map((ref) => this.currentRefs.get(ref)!)
          : [];
      if (
        (intent.kind === "attack" || intent.kind === "crush") &&
        !visible.has(intent.target)
      )
        throw new Error("Target is no longer visible");
      if ("x" in intent && !this.game.map.getTile(intent.x, intent.y)) continue;
      if (intent.kind === "queue") {
        if (changedQueues.has(intent.product.queue))
          throw new Error("Conflicting queue intent");
        changedQueues.add(intent.product.queue);
      }
      if ("refs" in intent) for (const ref of intent.refs) assigned.add(ref);
      const intentId = `intent-${this.intentSequence++}`;
      const origin = this.commander.intentOrigin(intent);
      try {
        switch (intent.kind) {
          case "deploy":
            this.player.actions.orderUnits(ids, OrderType.DeploySelected);
            break;
          case "queue":
            this.player.actions.queueForProduction(
              intent.product.queue,
              intent.product.name,
              intent.product.type,
              1,
            );
            break;
          case "place":
            this.player.actions.placeBuilding(intent.name, intent.x, intent.y);
            break;
          case "repair":
            if (owned.has(intent.ref))
              this.player.actions.toggleRepairWrench(
                this.currentRefs.get(intent.ref)!,
              );
            break;
          case "attack":
          case "crush":
            for (let n = 0; n < ids.length; n += 128)
              this.player.actions.orderUnits(
                ids.slice(n, n + 128),
                intent.kind === "crush"
                  ? OrderType.ForceMove
                  : OrderType.Attack,
                this.currentRefs.get(intent.target)!,
              );
            break;
          case "attackMove":
          case "move":
            for (let n = 0; n < ids.length; n += 128)
              this.player.actions.orderUnits(
                ids.slice(n, n + 128),
                intent.kind === "move" ? OrderType.Move : OrderType.AttackMove,
                intent.x,
                intent.y,
              );
            break;
        }
        this.trace?.({
          tick: o.tick,
          actor: this.name,
          kind: "submitted",
          intent,
          intentId,
          effect: "not_yet_observed",
          ...(origin ? { origin } : {}),
        });
        if (this.trace || origin)
          this.pendingEffects.push({
            ...rememberIntent(intentId, intent, o),
            ...(origin ? { origin } : {}),
          });
      } catch (error) {
        this.trace?.({
          tick: o.tick,
          actor: this.name,
          kind: "submission_error",
          intent,
          intentId,
          ...(origin ? { origin } : {}),
          possiblyPartiallySubmitted: true,
          error: String(error),
        });
        throw error;
      }
    }
  }
}
