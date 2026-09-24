import {
  Bot,
  ObjectType,
  OrderType,
  QueueStatus,
  type GameApi,
  type UnitData,
  type TechnoRules,
  type ApiEvent,
} from "@chronodivide/game-api";
import { OwnLifecycle } from "./own-lifecycle.js";
import { isOperationSchema } from "./learning/schema.js";
import { shouldScanPlacement } from "./commander/placement-clock.js";
import { baseRally, defenseRoute, guardPost } from "./defense-route.js";
import { refinerySite } from "./refinery-site.js";
import {
  defenseSite,
  defenseThreats,
  incomingFirePoints,
} from "./defense-placement.js";
import { MapPrior } from "./map-prior.js";
import { LocalGroundMap } from "./local-ground-map.js";
import { combatCapabilities, combatWeaponRange } from "./unit-capabilities.js";
import { Commander, type PolicyMode } from "./policy.js";
import type { ControlComponents } from "./control/contracts.js";
import {
  rememberIntent,
  observedEffect,
  type PendingEffect,
} from "./effects.js";
import {
  distance2,
  INTENT_KINDS,
  type Observation,
  type Intent,
  type Unit,
  type Point,
  type Product,
  type StrategicRegion,
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
  private footPrior?: MapPrior;
  private routes: NonNullable<Observation["routes"]> = [];
  private lastRoutesTick = -150;
  private oreFields: NonNullable<Observation["oreFields"]> = [];
  private lastOreTick = -300;
  private nativeToRef = new Map<number, string>();
  private currentRefs = new Map<string, number>();
  private sequence = 0;
  private readonly ownLifecycle = new OwnLifecycle();
  private lastObservation?: Observation;
  private lastSnapshotTick = -150;
  private intentSequence = 0;
  private pendingEffects: PendingEffect[] = [];
  private scoutPoints: readonly Point[] = [];
  private armySearchPoints: readonly Point[] = [];
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
  private catalogue?: Product[];
  private strategicRegions: StrategicRegion[] = [];
  private strategicEdges: [number, number][] = [];
  private placementChoices: NonNullable<Observation["placementChoices"]> = [];
  public trace?: (event: Trace) => void;
  public autoTick = false;
  public observation?: Observation;
  override onGameEvent(event: ApiEvent, gameApi: GameApi): void {
    super.onGameEvent(event, gameApi);
    this.ownLifecycle.onEvent(event, this.name);
  }
  constructor(
    name: string,
    country = "Americans",
    readonly mode: PolicyMode = "baseline",
    private readonly components?: Partial<ControlComponents>,
  ) {
    super(name, country);
    this.commander = new Commander(mode, components);
  }
  override onGameInit(game: GameApi): void {
    const side = this.player.getPlayerData().country!.side;
    this.mapPrior = MapPrior.readPregame(
      game,
      (
        game.rules.getObject(
          side === 0 ? "MTNK" : "HTNK",
          ObjectType.Vehicle,
        ) as TechnoRules
      ).speedType!,
    );
    this.footPrior = MapPrior.readPregame(
      game,
      (
        game.rules.getObject(
          side === 0 ? "E1" : "E2",
          ObjectType.Infantry,
        ) as TechnoRules
      ).speedType!,
      true,
    );
    if (this.components?.strategy?.observationScope === "commander-v1") {
      const groups = game.rules.general.prereqCategories;
      this.catalogue = [
        ...game.rules.buildingRules.values(),
        ...game.rules.infantryRules.values(),
        ...game.rules.vehicleRules.values(),
        ...game.rules.aircraftRules.values(),
      ]
        .filter((r) => r.techLevel >= 0)
        .map((r) => ({
          name: r.name,
          type: r.type,
          cost: r.cost,
          queue: this.player.production.getQueueTypeForObject(r),
          radar: r.radar,
          prerequisites: r.prerequisite,
          prerequisiteOverride: r.prerequisiteOverride,
          prerequisiteGroups: r.prerequisite.map((p) => {
            const category = [
              "POWER",
              "FACTORY",
              "BARRACKS",
              "RADAR",
              "TECH",
              "PROC",
            ].indexOf(p.toUpperCase());
            return category >= 0 ? (groups.get(category) ?? [p]) : [p];
          }),
          buildTimeMultiplier: r.buildTimeMultiplier,
          power: r.power,
          ...(r.freeUnit ? { grants: r.freeUnit } : {}),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
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
    const fullStrategy =
      this.components?.strategy?.observationScope === "commander-v1";
    if (tick - this.lastScoutScan >= 150) {
      const ownHome = { x: data.startLocation.x, y: data.startLocation.y };
      const mainRefs = new Set(this.commander.controlPlan?.combat.units ?? []);
      const scoutRefs = new Set(
        (this.commander.controlPlan?.additionalCombat ?? [])
          .filter((m) => m.kind === "scout")
          .flatMap((m) => m.units),
      );
      const knownOwn = this.lastObservation?.own ?? [];
      const regionFor = (nav: MapPrior | undefined, units: readonly Unit[]) => {
        const counts = new Map<number, number>();
        for (const u of units) {
          const id = nav?.region(u);
          if (id !== undefined) counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        return (
          [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ??
          nav?.region(ownHome)
        );
      };
      const vehicleRegion = regionFor(
        this.mapPrior,
        knownOwn.filter((u) => mainRefs.has(u.ref) && u.type === 7),
      );
      const footRegion = regionFor(
        this.footPrior,
        knownOwn.filter((u) => scoutRefs.has(u.ref)),
      );
      this.scoutPoints = Object.freeze(
        this.footPrior?.unexplored(this.game.map, this.name, footRegion) ?? [],
      );
      this.armySearchPoints = Object.freeze(
        this.mapPrior?.unexplored(this.game.map, this.name, vehicleRegion) ??
          [],
      );
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
      (u): Unit => {
        const ref = this.ref(u);
        this.ownLifecycle.seenOwn(u.id, ref);
        return {
          ref,
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
          ...(u.rules.harvester
            ? {
                cargo: (u.harvestedOre ?? 0) + (u.harvestedGems ?? 0),
              }
            : {}),
          mcv: !!u.rules.deploysInto && !u.rules.harvester,
          yard: u.rules.constructionYard,
          refinery: u.rules.refinery,
          radar: u.rules.radar,
          combat: u.rules.isSelectableCombatant,
          buildStatus: u.buildStatus,
          repairable: u.rules.repairable,
          hasWrenchRepair: u.hasWrenchRepair,
          ...(this.components?.strategy?.observationScope === "commander-v1"
            ? {
                sellable: u.type === ObjectType.Building && !u.rules.unsellable,
                engineer: u.rules.engineer,
              }
            : {}),
          deployed: u.stance === 3,
          crusher: u.rules.crusher,
          antiAir: combatCapabilities(u).antiAir,
          canThreatenVehicles: combatCapabilities(u).canThreatenVehicles,
          weaponRange: combatWeaponRange(u.primaryWeapon),
          weaponCooldown: u.primaryWeapon?.cooldownTicks,
          deployedWeaponRange: combatWeaponRange(u.secondaryWeapon),
        };
      },
    );
    const enemies = this.sorted(this.player.getVisibleUnits("enemy")).map(
      (u) => ({
        ref: this.ref(u),
        name: u.name,
        type: u.type,
        ...(this.components?.strategy ? { onBridge: u.onBridge } : {}),
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
      this.mapPrior.refreshVisible(this.game.map, this.name);
      this.footPrior?.refreshVisible(this.game.map, this.name);
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
          if (mission.kind === "advance" && units.every((u) => u.type !== 3))
            return [];
          const center = {
            x: Math.round(units.reduce((s, u) => s + u.x, 0) / units.length),
            y: Math.round(units.reduce((s, u) => s + u.y, 0) / units.length),
          };
          const navigation =
            units[0].type === 3 ? this.footPrior! : this.mapPrior!;
          const origin = [...units].sort(
            (a, b) => distance2(a, center) - distance2(b, center),
          )[0];
          const speed = (
            this.game.rules.getObject(
              units[0].name,
              units[0].type,
            ) as TechnoRules
          ).speedType;
          const post = navigation.points
            .filter((p) => distance2(p, mission.destination!) <= 8 ** 2)
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
          const path = navigation.path(
            { x: origin.x, y: origin.y, onBridge: origin.onBridge },
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
    const capturableBuildings = fullStrategy
      ? this.sorted(
          this.player.getVisibleUnits("hostile", (r) => r.capturable),
        ).map((u) => ({
          ref: this.ref(u),
          name: u.name,
          x: u.tile.rx,
          y: u.tile.ry,
        }))
      : undefined;
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
      for (const { x, y, bridge } of this.mapPrior?.points ?? []) {
        if (bridge) continue;
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
    if (fullStrategy && tick % 75 === 0) this.placementChoices = [];
    for (const q of queues.filter(
      (q) => q.status === QueueStatus.Ready && (q.type === 0 || q.type === 1),
    )) {
      const name = q.items[0]?.name;
      if (!name) continue;
      const buildingRules = this.game.rules.getBuilding(name);
      if (
        !shouldScanPlacement(
          fullStrategy,
          !!(buildingRules.isBaseDefense && buildingRules.primary),
          tick,
          this.lastFortSiteTick,
        )
      )
        continue;
      if (buildingRules.isBaseDefense && buildingRules.primary) {
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
      const plannedAnchor =
        productionPlan &&
        !("program" in productionPlan) &&
        productionPlan.defenses?.some((g) => g.product === name)
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
      if (fullStrategy && tick % 75 === 0) {
        const choices: { name: string; x: number; y: number }[] = [];
        for (const p of candidates.values()) {
          let explored = true;
          for (let x = p.x; x < p.x + foundation.width && explored; x++)
            for (let y = p.y; y < p.y + foundation.height; y++) {
              const tile = this.game.map.getTile(x, y);
              if (!tile || !this.game.map.isVisibleTile(tile, this.name)) {
                explored = false;
                break;
              }
            }
          const tile = this.game.map.getTile(p.x, p.y);
          if (explored && tile && this.player.canPlaceBuilding(name, tile))
            choices.push({ name, ...p });
        }
        this.placementChoices = [...this.placementChoices, ...choices];
      }
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
      ownDepartures: this.ownLifecycle.takeDepartures(),
      enemies,
      routes: this.routes,
      techBuildings,
      ...(capturableBuildings ? { capturableBuildings } : {}),
      vacatedContacts,
      oreFields: this.oreFields,
      products,
      queues,
      buildSites,
      scoutPoints: this.scoutPoints,
      armySearchPoints: this.armySearchPoints,
      exploredStarts: this.exploredStarts,
      scoutObservedTick: this.lastScoutScan,
      defenseRoute: this.defenseRoute,
      defensePosts: this.defensePosts,
      baseRally: this.baseRally,
      stagingRoute: this.stagingRoute,
      flankApproach: this.flankApproach,
    };
    if (fullStrategy && tick % 75 === 0) {
      const vehicle = this.mapPrior!.regionalObservation(
        this.game.map,
        this.name,
        true,
      );
      const foot = this.footPrior!.regionalObservation(
        this.game.map,
        this.name,
        false,
      );
      this.strategicRegions = [...vehicle.nodes, ...foot.nodes];
      this.strategicEdges = [
        ...vehicle.edges,
        ...foot.edges.map(([a, b]): [number, number] => [
          a + vehicle.nodes.length,
          b + vehicle.nodes.length,
        ]),
      ];
    }
    if (fullStrategy) {
      observation.regions = this.strategicRegions;
      observation.regionEdges = this.strategicEdges;
      const available = new Set(products.map((p) => p.name));
      observation.catalogue = this.catalogue!.map((p) => ({
        ...p,
        available: available.has(p.name),
      }));
      observation.placementChoices = this.placementChoices;
    }
    if (this.components?.strategy && tick % 75 === 0) {
      const points: Point[] = [
        ...own.filter((u) => u.type === 7),
        ...enemies,
        ...this.commander.launchPoints,
        ...observation.starts,
        ...this.armySearchPoints,
      ];
      const unique = new Map(
        points.map((p) => [`${p.x}:${p.y}:${Boolean(p.onBridge)}`, p]),
      );
      observation.launchGeometry = [...unique.values()].map((p) => ({
        x: p.x,
        y: p.y,
        ...(p.onBridge ? { onBridge: true } : {}),
        region: this.mapPrior?.region(p),
      }));
    }
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
    const result = this.commander.decide(observation);
    for (const record of this.commander.tacticalRecords)
      this.trace?.({
        tick: observation.tick,
        actor: this.name,
        kind: "armor_decision",
        record,
      });
    const record = this.commander.launchRecord as
      { tick?: number; schema?: string } | undefined;
    if (record?.tick === observation.tick)
      this.trace?.({
        tick: observation.tick,
        actor: this.name,
        kind:
          record.schema === "commander-v1"
            ? "commander_decision"
            : record.schema && isOperationSchema(record.schema)
              ? "operation_decision"
              : "launch_decision",
        record,
      });
    return result;
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
      if (!INTENT_KINDS.has(intent.kind))
        throw new Error("Unknown intent kind");
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
        !(o.capturableBuildings ?? o.techBuildings)?.some(
          (b) => b.ref === intent.target,
        )
      )
        throw new Error("Capture target is no longer visible");
      if ("x" in intent && !this.game.map.getTile(intent.x, intent.y)) continue;
      if (intent.kind === "queue" || intent.kind === "queueControl") {
        const queue =
          intent.kind === "queue" ? intent.product.queue : intent.queue;
        if (changedQueues.has(queue))
          throw new Error("Conflicting queue intent");
        changedQueues.add(queue);
      }
      if (
        intent.kind === "dock" &&
        !o.own.some((u) => u.ref === intent.target && u.refinery)
      )
        throw new Error("Return target is not an owned refinery");
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
            if (
              owned.has(intent.ref) &&
              !!o.own.find((u) => u.ref === intent.ref)?.hasWrenchRepair !==
                (intent.enabled ?? true)
            )
              this.player.actions.toggleRepairWrench(
                this.currentRefs.get(intent.ref)!,
              );
            break;
          case "sell":
            if (o.own.some((u) => u.ref === intent.ref && u.sellable))
              this.player.actions.sellObject(this.currentRefs.get(intent.ref)!);
            break;
          case "queueControl":
            if (intent.action === "pause")
              this.player.actions.pauseProduction(intent.queue);
            else if (intent.action === "resume")
              this.player.actions.resumeProduction(intent.queue);
            else
              for (const item of this.player.production.getQueueData(
                intent.queue,
              ).items)
                this.player.actions.unqueueFromProduction(
                  intent.queue,
                  item.rules.name,
                  item.rules.type,
                  item.quantity,
                );
            break;
          case "capture":
          case "dock":
            this.player.actions.orderUnits(
              ids,
              intent.kind === "dock" ? OrderType.Dock : OrderType.Capture,
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
          case "gather":
            for (let n = 0; n < ids.length; n += 128)
              this.player.actions.orderUnits(
                ids.slice(n, n + 128),
                intent.kind === "gather"
                  ? OrderType.Gather
                  : intent.kind === "move"
                    ? OrderType.Move
                    : OrderType.AttackMove,
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
