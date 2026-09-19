import {
  Bot,
  ObjectType,
  OrderType,
  QueueStatus,
  type GameApi,
  type UnitData,
  type TechnoRules,
} from "@chronodivide/game-api";
import { baseRally, defenseRoute, guardPost } from "./defense-route.js";
import { refinerySite } from "./refinery-site.js";
import {
  defenseSite,
  defenseThreats,
  incomingFirePoints,
} from "./defense-placement.js";
import { MapPrior } from "./map-prior.js";
import { LocalGroundMap } from "./local-ground-map.js";
import { combatCapabilities } from "./unit-capabilities.js";
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

export const OBSERVATION_PROTOCOL = "api-shroud-v1-pregame-map-prior";
export interface Trace {
  tick: number;
  actor: string;
  kind: string;
  [key: string]: unknown;
}

/** The only module that can query the engine or submit actions for this actor. */
export class WarbookBot extends Bot {
  private readonly commander: Commander;
  private mapPrior?: MapPrior;
  private routes: NonNullable<Observation["routes"]> = [];
  private lastRoutesTick = -150;
  private oreFields: NonNullable<Observation["oreFields"]> = [];
  private lastOreTick = -300;
  private nativeToRef = new Map<number, string>();
  private currentRefs = new Map<string, number>();
  private sequence = 0;
  private lastObservation?: Observation;
  private lastSnapshotTick = -150;
  private intentSequence = 0;
  private pendingEffects: PendingEffect[] = [];
  private scoutPoints: readonly Point[] = [];
  private scoutRevisitPoints: readonly Point[] = [];
  private exploredStarts: readonly Point[] = [];
  private lastScoutScan = -150;
  private lastControlReportTick = -150;
  private lastCombatRevision = -1;
  private lastProductionRevision = -1;
  private lastAdditionalRevisions = "";
  private defenseRoute?: Observation["defenseRoute"];
  private defensePosts: NonNullable<Observation["defensePosts"]> = [];
  private baseRally?: Point;
  private stagingRoute?: Observation["stagingRoute"];
  private flankApproach?: Observation["flankApproach"];
  private lastDefenseRouteTick = -150;
  private defenseRequestIds = "";
  private lastFortSiteTick = -30;
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
  override onGameInit(game: GameApi): void {
    this.mapPrior = MapPrior.readPregame(game);
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
      const revisit: Point[] = [];
      const scoutSpeed = (
        this.game.rules.getObject(
          data.country!.side === 0 ? "ADOG" : "DOG",
          ObjectType.Infantry,
        ) as TechnoRules
      ).speedType;
      for (let x = 4; x < size.width; x += 8)
        for (let y = 4; y < size.height; y += 8) {
          const tile = this.game.map.getTile(x, y);
          if (this.mapPrior && !this.mapPrior.closest({ x, y }, 0)) continue;
          // Static map domain and our own shroud only, without unseen terrain or occupancy queries.
          if (tile && !this.game.map.isVisibleTile(tile, this.name))
            points.push(Object.freeze({ x, y }));
          else if (
            tile &&
            this.game.map.isPassableTile(tile, scoutSpeed!, false, true)
          )
            revisit.push(Object.freeze({ x, y }));
        }
      this.scoutPoints = Object.freeze(points);
      this.scoutRevisitPoints = Object.freeze(revisit);
      this.exploredStarts = this.game.map
        .getStartingLocations()
        .filter((p) => {
          const tile = this.game.map.getTile(p.x, p.y);
          return tile && this.game.map.isVisibleTile(tile, this.name);
        })
        .map((p) => ({ x: p.x, y: p.y }));
      this.lastScoutScan = tick;
    }
    const own = this.sorted(this.player.getVisibleUnits("self")).map(
      (u): Unit => ({
        ref: this.ref(u),
        name: u.name,
        type: u.type,
        x: u.tile.rx,
        y: u.tile.ry,
        position: {
          x: u.worldPosition.x / 256,
          y: u.worldPosition.z / 256,
          z: u.worldPosition.y / 256,
        },
        attackState: u.attackState,
        onBridge: u.onBridge,
        sight: u.sight,
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
        radar: u.rules.radar,
        combat: u.rules.isSelectableCombatant,
        buildStatus: u.buildStatus,
        repairable: u.rules.repairable,
        hasWrenchRepair: u.hasWrenchRepair,
        deployed: u.stance === 3,
        crusher: u.rules.crusher,
        antiAir: combatCapabilities(u).antiAir,
        weaponRange: u.primaryWeapon?.maxRange,
        deployedWeaponRange: u.secondaryWeapon?.rules.neverUse
          ? undefined
          : u.secondaryWeapon?.maxRange,
      }),
    );
    const enemies = this.sorted(this.player.getVisibleUnits("enemy")).map(
      (u) => ({
        ref: this.ref(u),
        name: u.name,
        type: u.type,
        x: u.tile.rx,
        y: u.tile.ry,
        position: {
          x: u.worldPosition.x / 256,
          y: u.worldPosition.z / 256,
          z: u.worldPosition.y / 256,
        },
        hp: u.hitPoints,
        maxHp: u.maxHitPoints,
        observedTick: tick,
        deployed: u.stance === 3,
        airborne: u.zone === 1,
        ...combatCapabilities(u),
      }),
    );
    const visibleRefs = new Set(enemies.map((e) => e.ref));
    const vacatedContacts = (this.lastObservation?.enemies ?? [])
      .filter((e) => {
        if (
          visibleRefs.has(e.ref) ||
          tick - e.observedTick > 3 ||
          !["MTNK", "HTNK", "E1", "E2", "FV", "HTK", "ADOG", "DOG"].includes(
            e.name,
          )
        )
          return false;
        // Conservative three-tile envelope exceeds ordinary ground movement in
        // three pinned-engine ticks. Do not consult the missing native object.
        for (let x = e.x - 3; x <= e.x + 3; x++)
          for (let y = e.y - 3; y <= e.y + 3; y++) {
            const tile = this.game.map.getTile(x, y);
            if (tile && !this.game.map.isVisibleTile(tile, this.name))
              return false;
          }
        return true;
      })
      .map((e) => e.ref);
    if (tick - this.lastRoutesTick >= 90 && this.mapPrior) {
      this.mapPrior.updateVisibleBridges(this.game.map, this.name);
      const plan = this.commander.controlPlan;
      this.routes = [plan?.combat, ...(plan?.additionalCombat ?? [])].flatMap(
        (mission) => {
          if (
            !mission?.destination ||
            !mission.units.length ||
            ["screen", "capture"].includes(mission.kind)
          )
            return [];
          const units = own.filter((u) => mission.units.includes(u.ref));
          if (!units.length) return [];
          const center = {
            x: Math.round(units.reduce((s, u) => s + u.x, 0) / units.length),
            y: Math.round(units.reduce((s, u) => s + u.y, 0) / units.length),
          };
          const speed = (
            this.game.rules.getObject(
              units[0].name,
              units[0].type,
            ) as TechnoRules
          ).speedType;
          const post = this.mapPrior!.points.filter(
            (p) => distance2(p, mission.destination!) <= 8 ** 2,
          )
            .sort(
              (a, b) =>
                distance2(a, mission.destination!) -
                distance2(b, mission.destination!),
            )
            .find((p) => {
              if (
                own.some(
                  (b) =>
                    b.type === 2 &&
                    p.x >= b.x &&
                    p.x < b.x + b.width &&
                    p.y >= b.y &&
                    p.y < b.y + b.height,
                )
              )
                return false;
              const tile = this.game.map.getTile(p.x, p.y);
              return (
                !!tile &&
                (!this.game.map.isVisibleTile(tile, this.name) ||
                  (speed !== undefined &&
                    this.game.map.isPassableTile(
                      tile,
                      speed,
                      p.bridge,
                      units[0].type === 3,
                    )))
              );
            });
          const danger =
            mission.kind === "scout" || mission.id.startsWith("pressure-")
              ? enemies
                  .filter((e) => !e.airborne && (e.weaponRange ?? 0) > 0)
                  .map((e) => ({
                    x: e.x,
                    y: e.y,
                    radius: (e.weaponRange ?? 5) + 2,
                  }))
              : [];
          const path = this.mapPrior!.path(
            center,
            post ?? mission.destination,
            danger,
          );
          const waypoint =
            path
              .slice(1, danger.length ? 7 : 13)
              .reverse()
              .find((p) => {
                const tile = this.game.map.getTile(p.x, p.y);
                return (
                  tile &&
                  (!this.game.map.isVisibleTile(tile, this.name) ||
                    (speed !== undefined &&
                      this.game.map.isPassableTile(
                        tile,
                        speed,
                        !!p.onBridge,
                        units[0].type === 3,
                      )))
                );
              }) ?? path[path.length - 1];
          return path.length
            ? [
                {
                  task: mission.id,
                  towards: mission.destination,
                  waypoint,
                  post: post
                    ? {
                        x: post.x,
                        y: post.y,
                        ...(post.bridge ? { onBridge: true } : {}),
                      }
                    : undefined,
                  distance: path
                    .slice(1)
                    .reduce(
                      (d, p, i) => d + Math.sqrt(distance2(p, path[i])),
                      0,
                    ),
                },
              ]
            : [];
        },
      );
      this.lastRoutesTick = tick;
    }
    const techBuildings = this.sorted(
      this.player.getVisibleUnits(
        "hostile",
        (r) => r.capturable && r.produceCashAmount > 0,
      ),
    ).map((u) => ({
      ref: this.ref(u),
      name: u.name,
      x: u.tile.rx,
      y: u.tile.ry,
    }));
    const towards = this.commander.controlPlan?.additionalCombat?.find(
      (m) => m.approach,
    )?.approach;
    const staging = this.commander.controlPlan?.combat.approach;
    const requests = (this.commander.controlPlan?.additionalCombat ?? [])
      .filter((m) => m.kind === "defend" && m.approach && m.units.length)
      .slice(0, 2);
    const requestIds = requests
      .map((m) => m.id)
      .sort()
      .join(",");
    const newApproach = requestIds !== this.defenseRequestIds;
    if (
      (towards || staging) &&
      (newApproach || tick - this.lastDefenseRouteTick >= 150)
    ) {
      const home = { x: data.startLocation.x, y: data.startLocation.y };
      const speed = (
        this.game.rules.getObject(
          data.country!.side === 0 ? "MTNK" : "HTNK",
          ObjectType.Vehicle,
        ) as TechnoRules
      ).speedType;
      const navigation =
        speed === undefined
          ? undefined
          : new LocalGroundMap(this.game.map, this.name, home, speed, 22);
      const occupied = own
        .filter((u) => u.type === ObjectType.Building)
        .map((u) => ({
          ref: u.ref,
          x: u.x,
          y: u.y,
          width: u.width,
          height: u.height,
          defense: (u.weaponRange ?? 0) > 0,
        }));
      this.baseRally = navigation
        ? baseRally(navigation, home, occupied)
        : undefined;
      const footSpeed = (
        this.game.rules.getObject(
          data.country!.side === 0 ? "E1" : "E2",
          ObjectType.Infantry,
        ) as TechnoRules
      ).speedType;
      const infantryNavigation =
        footSpeed === undefined
          ? undefined
          : new LocalGroundMap(
              this.game.map,
              this.name,
              home,
              footSpeed,
              22,
              true,
            );
      this.defensePosts = infantryNavigation
        ? requests.flatMap((m) => {
            const point = guardPost(
              infantryNavigation,
              home,
              m.approach!,
              occupied,
              m.protectedAssets,
            );
            return point
              ? [
                  {
                    task: m.id,
                    towards: m.approach!,
                    point,
                    observedTick: tick,
                  },
                ]
              : [];
          })
        : [];
      const localApproach = (goal: Point) => {
        const path = this.mapPrior?.path(home, goal) ?? [];
        return path[Math.min(16, path.length - 1)] ?? goal;
      };
      if (
        staging &&
        this.mapPrior &&
        (!this.flankApproach ||
          distance2(this.flankApproach.towards, staging) > 8 ** 2 ||
          tick - this.flankApproach.observedTick >= 900)
      ) {
        const flank = this.mapPrior.flank(home, staging);
        this.flankApproach = flank
          ? { towards: staging, point: flank, observedTick: tick }
          : undefined;
      }
      const point =
        towards && infantryNavigation
          ? guardPost(
              infantryNavigation,
              home,
              localApproach(towards),
              occupied,
            )
          : undefined;
      this.defenseRoute =
        point && towards ? { towards, point, observedTick: tick } : undefined;
      const stagePoint =
        staging && speed !== undefined
          ? defenseRoute(
              this.game.map,
              this.name,
              home,
              localApproach(staging),
              speed,
              navigation,
              occupied,
            )
          : undefined;
      this.stagingRoute =
        stagePoint && staging
          ? { towards: staging, point: stagePoint, observedTick: tick }
          : undefined;
      this.lastDefenseRouteTick = tick;
      this.defenseRequestIds = requestIds;
    }
    if (tick - this.lastOreTick >= 300) {
      const fields: { x: number; y: number; amount: number }[] = [];
      for (
        let x = data.startLocation.x - 45;
        x <= data.startLocation.x + 45;
        x++
      )
        for (
          let y = data.startLocation.y - 45;
          y <= data.startLocation.y + 45;
          y++
        ) {
          const tile = this.game.map.getTile(x, y);
          if (!tile || !this.game.map.isVisibleTile(tile, this.name)) continue;
          const r = this.game.map.getTileResourceData(tile),
            amount = (r?.ore ?? 0) + 2 * (r?.gems ?? 0);
          if (!amount) continue;
          const field = fields.find((p) => distance2(p, { x, y }) < 10 ** 2);
          if (field) field.amount += amount;
          else fields.push({ x, y, amount });
        }
      this.oreFields = fields;
      this.lastOreTick = tick;
    }
    const products = this.player.production.getAvailableObjects().map((p) => ({
      name: p.name,
      type: p.type,
      cost: p.cost,
      queue: this.player.production.getQueueTypeForObject(p),
      radar: p.radar,
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
      const buildingRules = this.game.rules.getBuilding(name);
      if (buildingRules.isBaseDefense && buildingRules.primary) {
        if (tick - this.lastFortSiteTick < 30) continue;
        this.lastFortSiteTick = tick;
      }
      const { foundation } = this.game.getBuildingPlacementData(name);
      const candidates = new Map<string, { x: number; y: number }>();
      const buildings = own.filter((u) => u.type === ObjectType.Building);
      for (const b of buildings) {
        for (let x = b.x - 7; x <= b.x + b.width + 7; x++)
          for (let y = b.y - 7; y <= b.y + b.height + 7; y++) {
            candidates.set(`${x},${y}`, { x, y });
          }
      }
      const home = { x: data.startLocation.x, y: data.startLocation.y };
      const enemy = enemies
        .slice()
        .sort((a, b) => distance2(a, home) - distance2(b, home))[0];
      const productionPlan = this.commander.controlPlan?.production;
      const plannedAnchor = productionPlan?.defenses?.some(
        (g) => g.product === name,
      )
        ? productionPlan.defenseAnchor
        : undefined;
      const anchor = this.game.rules.getBuilding(name).isBaseDefense
        ? (plannedAnchor ?? enemy ?? home)
        : home;
      const legal = (p: Point) => {
        // The union of candidates from several parents must retain clearance
        // from every building, not just the parent that generated this point.
        if (
          buildings.some(
            (b) =>
              p.x < b.x + b.width + 1 &&
              p.x + foundation.width > b.x - 1 &&
              p.y < b.y + b.height + 1 &&
              p.y + foundation.height > b.y - 1,
          )
        )
          return false;
        for (let x = p.x; x < p.x + foundation.width; x++)
          for (let y = p.y; y < p.y + foundation.height; y++) {
            const tile = this.game.map.getTile(x, y);
            if (!tile || !this.game.map.isVisibleTile(tile, this.name))
              return false;
          }
        const tile = this.game.map.getTile(p.x, p.y);
        return !!tile && this.player.canPlaceBuilding(name, tile);
      };
      if (buildingRules.isBaseDefense && buildingRules.primary) {
        const foot = this.game.rules.getObject(
          data.country!.side === 0 ? "E1" : "E2",
          ObjectType.Infantry,
        ) as TechnoRules;
        if (foot.speedType !== undefined) {
          const navigation = new LocalGroundMap(
            this.game.map,
            this.name,
            home,
            foot.speedType,
            22,
            true,
          );
          const site = defenseSite(
            home,
            own,
            enemies,
            navigation.points,
            [...candidates.values()].filter(legal),
            foundation,
            this.game.rules.getWeapon(buildingRules.primary).range,
            defenseThreats(own, enemies).length
              ? incomingFirePoints(navigation, own, enemies)
              : this.defenseRoute
                ? [this.defenseRoute.point]
                : [],
          );
          if (site) {
            buildSites.push({ name, ...site.point });
            this.trace?.({
              tick,
              actor: this.name,
              kind: "defense_site",
              ...site,
            });
            continue;
          }
        }
        continue;
      }
      if (["GAREFN", "NAREFN"].includes(name)) {
        const miner = name === "GAREFN" ? "CMIN" : "HARV";
        const speed = (
          this.game.rules.getObject(miner, ObjectType.Vehicle) as TechnoRules
        ).speedType;
        const site =
          speed === undefined
            ? undefined
            : refinerySite(
                this.game.map,
                this.name,
                home,
                [...candidates.values()],
                foundation,
                speed,
                legal,
              );
        if (site) {
          buildSites.push({ name, ...site.point });
          this.trace?.({
            tick,
            actor: this.name,
            kind: "refinery_site",
            ...site,
          });
          continue;
        }
      }
      for (const p of [...candidates.values()].sort(
        (a, b) =>
          distance2(a, anchor) - distance2(b, anchor) || a.x - b.x || a.y - b.y,
      )) {
        if (legal(p)) {
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
      routes: this.routes,
      techBuildings,
      vacatedContacts,
      oreFields: this.oreFields,
      products,
      queues,
      buildSites,
      scoutPoints: this.scoutPoints,
      scoutRevisitPoints: this.scoutRevisitPoints,
      exploredStarts: this.exploredStarts,
      scoutObservedTick: this.lastScoutScan,
      defenseRoute: this.defenseRoute,
      defensePosts: this.defensePosts,
      baseRally: this.baseRally,
      stagingRoute: this.stagingRoute,
      flankApproach: this.flankApproach,
    };
    if (this.lastObservation) {
      const previousContacts = new Set(
        this.lastObservation.enemies.map((e) => e.ref),
      );
      const baseContacts = enemies.filter(
        (e) =>
          (e.type === 2 || ["AMCV", "SMCV"].includes(e.name)) &&
          !previousContacts.has(e.ref),
      );
      if (baseContacts.length)
        this.trace?.({
          tick,
          actor: this.name,
          kind: "base_contact",
          contacts: baseContacts,
        });
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
    const additionalRevisions = JSON.stringify(
      plan?.additionalCombat?.map((m) => [m.id, m.revision]) ?? [],
    );
    if (plan && plan.tick !== o.tick) throw new Error("Stale control decision");
    if (
      plan &&
      (plan.combat.revision !== this.lastCombatRevision ||
        plan.production.revision !== this.lastProductionRevision ||
        additionalRevisions !== this.lastAdditionalRevisions)
    ) {
      this.trace?.({
        tick: o.tick,
        actor: this.name,
        kind: "strategic_plan",
        plan,
      });
      this.lastCombatRevision = plan.combat.revision;
      this.lastProductionRevision = plan.production.revision;
      this.lastAdditionalRevisions = additionalRevisions;
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
      if (
        intent.kind === "capture" &&
        !o.techBuildings?.some((b) => b.ref === intent.target)
      )
        throw new Error("Capture target is no longer visible");
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
          case "stop":
            this.player.actions.orderUnits(ids, OrderType.Stop);
            break;
          case "scatter":
            this.player.actions.orderUnits(ids, OrderType.Scatter);
            break;
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
          case "capture":
            this.player.actions.orderUnits(
              ids,
              OrderType.Capture,
              this.currentRefs.get(intent.target)!,
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
                intent.onBridge ?? false,
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
