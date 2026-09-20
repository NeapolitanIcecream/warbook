import {
  distance2,
  type Observation,
  type Point,
  type Unit,
} from "../model.js";
import { OpeningStrategy } from "./strategy.js";
import { DefenseAssignments } from "./defense-assignments.js";
import { DefenseSituation } from "./defense-situation.js";
import { DefenseRelief } from "./defense-relief.js";
import { isScout, Reconnaissance } from "./reconnaissance.js";
import { MiningArea } from "./harvesters.js";
import { NeutralEconomy } from "./neutral-economy.js";
import { Operations } from "./operations.js";
import {
  LegacyLaunchProvider,
  type LaunchProvider,
} from "./launch-provider.js";
import { formedUnits, rendezvous } from "./formation.js";
import {
  TaskRevision,
  type CombatMission,
  type StrategicController,
  type StrategicPlan,
  type TacticalAssessment,
  type ControlReport,
} from "./contracts.js";

/** A local defender with persistent counterattack membership and a separate garrison. */
export class BastionStrategy implements StrategicController {
  readonly id: string;
  private readonly opening = new OpeningStrategy();
  private readonly defense = new DefenseAssignments();
  private readonly situation = new DefenseSituation();
  private readonly relief = new DefenseRelief();
  private readonly neutral = new NeutralEconomy();
  private readonly recon = new Reconnaissance();
  private readonly operations = new Operations();
  private readonly legacyLaunch = new LegacyLaunchProvider();
  private readonly revisions = new Map<string, TaskRevision>();
  private readonly productionRevision = new TaskRevision();
  private assault = new Set<string>();
  private joining = new Set<string>();
  private withdrawing = new Set<string>();
  private withdrawalPoint?: Point;
  private nextLaunchTick = 0;
  private readonly launchSize = 6;
  private firstForceFunded = false;
  private producedArmor = new Set<string>();
  private launchedArmor = 6;
  private transition: Record<string, number | string> = {};
  private resourcePost?: Point;
  private readonly mining = new MiningArea();
  private mineGuards = new Set<string>();
  private scoutRefs = new Set<string>();
  private flankRefs = new Set<string>();
  private flankVia?: Point;
  private flankAttempted = false;
  private developSiege = false;
  private heldForWave = new Set<string>();
  private launchThreats = new Set<string>();
  private launchTick = -Infinity;

  constructor(
    private readonly doctrine: "bastion" | "cohort" = "bastion",
    private readonly launchProvider?: LaunchProvider,
  ) {
    this.id =
      doctrine === "bastion" ? "bastion-strategy-v11" : "cohort-strategy-v6";
  }
  get launchRecord() {
    return this.launchProvider?.record;
  }
  launchPoints(): readonly Point[] {
    return this.launchProvider
      ? this.operations.contacts.filter(
          (e) => e.type === 2 || ["AMCV", "SMCV"].includes(e.name),
        )
      : [];
  }

  assessmentRequest(o: Observation) {
    return this.opening.assessmentRequest(o);
  }

  private mission(
    id: string,
    description: Omit<CombatMission, "id" | "revision">,
  ): CombatMission {
    let revision = this.revisions.get(id);
    if (!revision) this.revisions.set(id, (revision = new TaskRevision()));
    return {
      id,
      revision: revision.update({
        ...description,
        units: [...description.units].sort(),
      }),
      ...description,
    };
  }

  plan(
    o: Observation,
    assessment: TacticalAssessment,
    feedback?: ControlReport,
  ): StrategicPlan {
    const base = this.opening.plan(o, assessment);
    const { unitType: armor, factoryType: factory } = this.assessmentRequest(o);
    const combatArmor = (u: Unit) => u.name === armor || u.name === "SREF";
    for (const u of o.own) if (u.name === armor) this.producedArmor.add(u.ref);
    if (this.producedArmor.size >= this.launchSize)
      this.firstForceFunded = true;
    const dogs = assessment.army.filter(isScout);
    for (const ref of this.scoutRefs)
      if (!dogs.some((u) => u.ref === ref)) this.scoutRefs.delete(ref);
    for (const dog of dogs) {
      if (this.scoutRefs.size >= (o.starts.length > 2 ? 2 : 1)) break;
      this.scoutRefs.add(dog.ref);
    }
    const scouts = dogs.filter((u) => this.scoutRefs.has(u.ref));
    const infantry = assessment.army.filter((u) => u.type === 3 && !isScout(u));
    const allVehicles = assessment.army.filter((u) => u.type !== 3);
    const searchForce = allVehicles.filter(
      (u) => this.assault.has(u.ref) && !this.flankRefs.has(u.ref),
    );
    const searchOrigin = searchForce.length
      ? rendezvous(searchForce, true)
      : o.home;
    const startsToCheck = o.starts.filter(
      (p) =>
        distance2(p, o.home) > 12 ** 2 &&
        !(o.exploredStarts ?? []).some((seen) => distance2(seen, p) < 1),
    );
    const searchGoal = [
      ...(startsToCheck.length
        ? startsToCheck
        : (o.armySearchPoints ?? o.scoutPoints ?? [])),
    ].sort(
      (a, b) => distance2(a, searchOrigin) - distance2(b, searchOrigin),
    )[0];
    const alive = new Set(allVehicles.map((u) => u.ref));
    const hadAssault = this.assault.size > 0;
    this.assault = new Set([...this.assault].filter((ref) => alive.has(ref)));
    this.joining = new Set([...this.joining].filter((ref) => alive.has(ref)));
    const {
      direction,
      post,
      assets,
      guardAssets,
      incursions,
      guardIncursions,
      vehiclePost,
      protectNow,
      responding,
      damagedAt,
    } = this.situation.observe(o);
    const freshDefense =
      !this.launchProvider?.experimental ||
      incursions.some(
        (i) =>
          !this.launchThreats.has(`${i.enemy.ref}:${i.asset.ref}`) ||
          (damagedAt.get(i.asset.ref) ?? -Infinity) > this.launchTick,
      );
    const relief = this.relief.assign(
      o,
      allVehicles.filter(
        (u) =>
          !this.withdrawing.has(u.ref) &&
          (freshDefense || !this.assault.has(u.ref)),
      ),
      infantry,
      [...new Map(incursions.map((i) => [i.enemy.ref, i.enemy])).values()],
      vehiclePost,
      this.assault,
      responding && this.assault.size > 0 && freshDefense,
    );
    const reliefRefs = new Set(relief.map((u) => u.ref));
    for (const ref of reliefRefs) {
      this.assault.delete(ref);
      this.joining.delete(ref);
    }
    const vehicles = allVehicles.filter((u) => !reliefRefs.has(u.ref));
    this.operations.observe(o, [
      ...new Map(incursions.map((i) => [i.enemy.ref, i.enemy])).values(),
    ]);
    const fallbackDirection =
      o.starts
        .filter((p) => distance2(p, o.home) > 25)
        .sort((a, b) => distance2(a, o.home) - distance2(b, o.home))[0] ??
      direction;
    const stagingDirection = this.operations.stagingDirection(
      o,
      fallbackDirection,
    );
    const stagingPost =
      o.stagingRoute &&
      distance2(o.stagingRoute.towards, stagingDirection) <= 8 ** 2 &&
      o.tick - o.stagingRoute.observedTick <= 450
        ? o.stagingRoute.point
        : post;
    const workingField = this.mining.observe(o);
    const mineThreat = workingField
      ? [...o.enemies]
          .filter(
            (e) => (e.weaponRange ?? 0) > 0 && e.canThreatenVehicles !== false,
          )
          .sort(
            (a, b) => distance2(a, workingField) - distance2(b, workingField),
          )[0]
      : undefined;
    const mineApproach = mineThreat ?? stagingDirection;
    if (workingField) {
      const dx = mineApproach.x - workingField.x,
        dy = mineApproach.y - workingField.y;
      const length = Math.hypot(dx, dy) || 1;
      this.resourcePost = {
        x: Math.round(workingField.x + (4 * dx) / length),
        y: Math.round(workingField.y + (4 * dy) / length),
      };
    } else this.resourcePost = undefined;
    const musterPost = responding
      ? vehiclePost
      : this.firstForceFunded && this.resourcePost
        ? this.resourcePost
        : stagingPost;
    const outsideFactory = (u: Unit) =>
      !o.own.some(
        (b) =>
          b.name === factory &&
          u.x >= b.x &&
          u.x < b.x + b.width &&
          u.y >= b.y &&
          u.y < b.y + b.height,
      );
    const center = rendezvous;
    const covered = (p: Point) =>
      o.own.some(
        (u) =>
          u.type === 2 &&
          p.x >= u.x &&
          p.x < u.x + u.width &&
          p.y >= u.y &&
          p.y < u.y + u.height,
      );
    if (
      this.withdrawalPoint &&
      covered(this.withdrawalPoint) &&
      o.baseRally &&
      !covered(o.baseRally)
    )
      this.withdrawalPoint = o.baseRally;
    for (const ref of this.withdrawing) {
      const u = vehicles.find((u) => u.ref === ref);
      if (
        !u ||
        (!u.onBridge &&
          this.withdrawalPoint &&
          distance2(u, this.withdrawalPoint) <= 4 ** 2)
      )
        this.withdrawing.delete(ref);
    }
    const beginWithdrawal = () => {
      this.withdrawalPoint = o.baseRally ?? post;
      for (const u of vehicles)
        if (
          (this.assault.has(u.ref) || this.joining.has(u.ref)) &&
          (u.onBridge || distance2(u, this.withdrawalPoint) > 4 ** 2)
        )
          this.withdrawing.add(u.ref);
    };
    const guardCandidates = vehicles.filter(
      (u) =>
        u.name === armor &&
        outsideFactory(u) &&
        !this.assault.has(u.ref) &&
        !this.joining.has(u.ref) &&
        !this.withdrawing.has(u.ref),
    );
    const guardCount =
      this.resourcePost &&
      workingField &&
      distance2(workingField, o.home) > 12 ** 2 &&
      !protectNow &&
      vehicles.filter(combatArmor).length >= 8
        ? 2
        : 0;
    const mineGuards = guardCandidates
      .sort(
        (a, b) =>
          Number(this.mineGuards.has(b.ref)) -
            Number(this.mineGuards.has(a.ref)) ||
          distance2(a, this.resourcePost ?? o.home) -
            distance2(b, this.resourcePost ?? o.home),
      )
      .slice(0, guardCount);
    this.mineGuards = new Set(mineGuards.map((u) => u.ref));
    const isReserve = (u: Unit) =>
      !this.mineGuards.has(u.ref) &&
      !this.assault.has(u.ref) &&
      !this.joining.has(u.ref) &&
      !this.withdrawing.has(u.ref);
    let assault = vehicles.filter((u) => this.assault.has(u.ref));
    if (
      hadAssault &&
      assault.filter(combatArmor).length < Math.min(3, this.launchedArmor)
    ) {
      this.transition = {
        operationTransition: "force-depleted",
        operationTransitionTick: o.tick,
      };
      beginWithdrawal();
      this.assault.clear();
      this.joining.clear();
      this.operations.active = undefined;
      assault = [];
      this.nextLaunchTick = o.tick + 450;
    }
    if (
      this.operations.active?.reason === "formed-advance" &&
      !this.operations.hasKnownBase &&
      searchGoal
    )
      this.operations.active.point = searchGoal;
    let operation = this.operations.target(o, assault);
    // Clearing one area starts the next search from the army's current position.
    // It is a task completion, not evidence that the expedition was defeated.
    if (assault.length && !operation && searchGoal) {
      this.transition = {
        operationTransition: "area-cleared-continue-search",
        operationTransitionTick: o.tick,
      };
      operation = {
        point: searchGoal,
        reason: "formed-advance",
        defenders: 0,
        productionArrivals: 0,
        travelSeconds: 0,
      };
      this.operations.active = operation;
    }
    if (assault.length && !operation) {
      beginWithdrawal();
      this.assault.clear();
      this.joining.clear();
      assault = [];
    }
    let reserve = vehicles.filter(isReserve);
    if (!this.assault.size && !this.joining.size) this.heldForWave.clear();
    const ready = formedUnits(
      reserve.filter(
        (u) => outsideFactory(u) && distance2(u, musterPost) <= 12 ** 2,
      ),
      musterPost,
    );
    const alternative =
      o.flankApproach &&
      distance2(o.flankApproach.towards, stagingDirection) <= 10 ** 2
        ? o.flankApproach.point
        : undefined;
    const proposal = (this.launchProvider ?? this.legacyLaunch).choose({
      observation: o,
      operations: this.operations,
      ready,
      active: !!assault.length,
      protectNow,
      nextLaunchTick: this.nextLaunchTick,
      firstForceFunded: this.firstForceFunded,
      hasScouts: !!scouts.length,
      searchGoal,
      launchSize: this.launchSize,
      armor,
      reserve,
      slotFree: !this.assault.size && !this.joining.size,
    });
    if (proposal) {
      const nextOperation = proposal.operation;
      const committed = proposal.units;
      this.assault = new Set(committed.map((u) => u.ref));
      this.launchedArmor = committed.filter(combatArmor).length;
      if (proposal.origin === "experiment") {
        this.heldForWave = new Set(
          reserve.filter((u) => !this.assault.has(u.ref)).map((u) => u.ref),
        );
        this.launchThreats = new Set(
          incursions.map((i) => `${i.enemy.ref}:${i.asset.ref}`),
        );
        this.launchTick = o.tick;
      }
      this.transition = {
        operationTransition: nextOperation.reason,
        operationTransitionTick: o.tick,
      };
      this.operations.active = nextOperation;
      operation = nextOperation;
      this.flankRefs.clear();
      this.flankVia = undefined;
      this.flankAttempted = false;
      if (
        nextOperation.reason === "formed-pressure" &&
        committed.filter((u) => u.name === armor).length >= 12 &&
        alternative
      ) {
        this.flankAttempted = true;
        operation = this.operations.active = {
          ...nextOperation,
          reason: "two-front-pressure",
        };
        this.transition = {
          operationTransition: "two-front-pressure",
          operationTransitionTick: o.tick,
        };
        this.flankVia = alternative;
        this.flankRefs = new Set(
          [...committed]
            .sort(
              (a, b) => distance2(a, alternative) - distance2(b, alternative),
            )
            .slice(0, Math.floor(committed.length / 2))
            .map((u) => u.ref),
        );
      }
      assault = vehicles.filter((u) => this.assault.has(u.ref));
    }
    if (assault.length) {
      const mergePoint = center(assault);
      for (const u of vehicles.filter((u) => this.joining.has(u.ref)))
        if (distance2(u, mergePoint) <= 8 ** 2) {
          this.joining.delete(u.ref);
          this.assault.add(u.ref);
        }
      reserve = vehicles.filter(isReserve);
      const nextBatch = formedUnits(
        reserve.filter(
          (u) =>
            !this.heldForWave.has(u.ref) &&
            outsideFactory(u) &&
            distance2(u, musterPost) <= 12 ** 2,
        ),
        musterPost,
      );
      if (
        !this.joining.size &&
        nextBatch.filter((u) => u.name === armor).length >=
          (assault.filter((u) => u.name === armor).length <= 3 ||
          nextBatch.some((u) => u.name === "SREF")
            ? 2
            : 4)
      )
        this.joining = new Set(nextBatch.map((u) => u.ref));
    }
    assault = vehicles.filter((u) => this.assault.has(u.ref));
    const joiners = vehicles.filter((u) => this.joining.has(u.ref));
    reserve = vehicles.filter(isReserve);
    const withdrawing = vehicles.filter((u) => this.withdrawing.has(u.ref));
    if (
      !this.flankAttempted &&
      alternative &&
      assault.filter((u) => u.name === armor).length >= 12 &&
      feedback?.combat.facts.holdingContact
    ) {
      const available = assault
        .filter((u) => u.name === armor && (u.attackState ?? 0) < 3)
        .sort((a, b) => distance2(a, alternative) - distance2(b, alternative));
      if (available.length >= 6) {
        this.flankRefs = new Set(
          available
            .slice(
              0,
              Math.min(available.length, Math.floor(assault.length / 2)),
            )
            .map((u) => u.ref),
        );
        this.flankVia = alternative;
        this.flankAttempted = true;
        this.transition = {
          operationTransition: "flank-blocked-contact",
          operationTransitionTick: o.tick,
        };
      }
    }
    const fort = o.side === 0 ? "GAPILL" : "NALASR";
    const refinery = o.side === 0 ? "GAREFN" : "NAREFN";
    const mobilizing = !this.firstForceFunded;
    if (
      o.side === 0 &&
      this.producedArmor.size >= 16 &&
      assessment.observedArmor >= 8 &&
      o.credits >= 500 &&
      !responding &&
      this.operations.hasKnownBase &&
      (!operation ||
        ["two-front-pressure", "ranged-pressure", "formed-pressure"].includes(
          operation.reason,
        ))
    )
      this.developSiege = true;
    const resourceFields = (o.oreFields ?? []).filter((f) => f.amount >= 180);
    const expand =
      !mobilizing &&
      resourceFields.length >= 2 &&
      assessment.observedArmor >= 8 &&
      assessment.observedArmor >=
        o.enemies.filter((e) => ["MTNK", "HTNK"].includes(e.name)).length + 3 &&
      !protectNow &&
      o.credits >= 2000;
    const economyStructures = base.production.structures.map((g) => ({
      ...g,
      count:
        g.product === refinery && g.count > 1
          ? expand
            ? 3
            : g.count
          : g.count,
    }));
    const radar =
      o.own.find((u) => u.radar)?.name ?? o.products.find((p) => p.radar)?.name;
    if (this.developSiege && radar)
      economyStructures.push(
        { product: radar, count: 1 },
        { product: "GATECH", count: 1 },
      );
    const income = this.neutral.plan(o);
    const economy = {
      ...base.production,
      structures: economyStructures,
      vehicles: {
        ...base.production.vehicles,
        harvesters: expand ? 5 : base.production.vehicles.harvesters,
        ...(this.developSiege && assessment.observedArmor >= 8
          ? { siege: { product: "SREF", count: 3 } }
          : {}),
      },
      spending: {
        ...base.production.spending,
        infantryAbove: mobilizing ? 800 : 300,
      },
      engineers: {
        product: o.side === 0 ? "ENGINEER" : "SENGINEER",
        count: income.demand,
      },
      scouts: {
        product: o.side === 0 ? "ADOG" : "DOG",
        required: o.starts.length > 2 ? 2 : 1,
        count: (o.starts.length > 2 ? 2 : 1) + (this.firstForceFunded ? 2 : 0),
      },
      ...(mobilizing
        ? {
            structures: base.production.structures.map((g) => ({
              ...g,
              count: [refinery, factory].includes(g.product)
                ? Math.min(1, g.count)
                : g.count,
            })),
            vehicles: { ...base.production.vehicles, harvesters: 2 },
          }
        : {}),
      defenseAnchor: post,
      defenses: [
        {
          product: fort,
          count:
            this.doctrine === "bastion" && o.own.some((u) => u.name === factory)
              ? 1
              : 0,
        },
      ],
    };
    const { revision: _oldRevision, ...productionDescription } = economy;
    const production = {
      ...economy,
      revision: this.productionRevision.update(productionDescription),
    };

    for (const ref of this.flankRefs)
      if (!this.assault.has(ref)) this.flankRefs.delete(ref);
    let flank = assault.filter((u) => this.flankRefs.has(u.ref));
    if (flank.length === assault.length) {
      this.flankRefs.clear();
      flank = [];
    }
    if (
      !flank.length ||
      (this.flankVia && distance2(center(flank), this.flankVia) <= 6 ** 2)
    )
      this.flankVia = undefined;
    const primary = assault.filter((u) => !this.flankRefs.has(u.ref));
    const combat = this.mission("main-force", {
      kind: assault.length
        ? "advance"
        : responding || protectNow
          ? "defend"
          : "assemble",
      units: (assault.length ? primary : reserve).map((u) => u.ref),
      destination: assault.length ? operation?.point : musterPost,
      groundDestination: assault.length ? operation?.point : musterPost,
      objective:
        protectNow && !assault.length
          ? "protect-base"
          : assault.length
            ? (operation?.reason ?? "reassess-operation")
            : responding
              ? "protect-economy"
              : this.resourcePost && this.firstForceFunded
                ? "hold-mining-approach"
                : "muster-counterattack",
      engagement: { allowCrush: true },
      approach: stagingDirection,
      ...(assault.length && operation?.ref ? { target: operation.ref } : {}),
    });
    const guards = this.defense.assign(
      o.tick,
      infantry,
      guardIncursions,
      damagedAt,
      o.own,
    );
    const additionalCombat = guards.length
      ? guards.map((guard) =>
          this.mission(guard.id, {
            kind: "defend",
            units: guard.units,
            destination:
              o.defensePosts?.find(
                (p) => p.task === guard.id && o.tick - p.observedTick <= 450,
              )?.point ?? guard.destination,
            objective: guard.urgent
              ? "protect-critical-building"
              : "guard-approach",
            threats: guard.threats,
            protectedAssets: guard.protectedAssets,
            approach: guard.approach,
            engagement: {
              allowCrush: false,
              ...(guard.urgent ? { interrupt: true } : {}),
            },
          }),
        )
      : [
          this.mission("base-garrison", {
            kind: "defend",
            units: infantry.map((u) => u.ref),
            destination: post,
            objective: "guard-base",
            protectedAssets: guardAssets.map((u) => u.ref).sort(),
            approach: direction,
            engagement: { allowCrush: false },
          }),
        ];
    if (mineGuards.length && this.resourcePost)
      additionalCombat.push(
        this.mission("mining-screen", {
          kind: "defend",
          units: mineGuards.map((u) => u.ref),
          destination: this.resourcePost,
          objective: "screen-working-mining-area",
          protectedAssets: o.own.filter((u) => u.harvester).map((u) => u.ref),
          engagement: { allowCrush: true },
        }),
      );
    const miners = o.own.filter((u) => u.harvester);
    if (miners.length)
      additionalCombat.push(
        this.mission("mining-safety", {
          kind: "harvest",
          units: miners.map((u) => u.ref),
          objective: "preserve-miners-and-income",
          engagement: { allowCrush: false },
        }),
      );
    if (flank.length)
      additionalCombat.push(
        this.mission("flank-force", {
          kind: "advance",
          units: flank.map((u) => u.ref),
          destination: this.flankVia ?? operation?.point,
          objective: this.flankVia
            ? "approach-other-entrance"
            : "flank-defended-base",
          ...(!this.flankVia && operation?.ref
            ? { target: operation.ref }
            : {}),
          engagement: { allowCrush: true },
        }),
      );
    if (relief.length)
      additionalCombat.push(
        this.mission("base-relief", {
          kind: "defend",
          units: relief.map((u) => u.ref),
          destination: this.relief.destination ?? vehiclePost,
          objective: "reinforce-base-defense",
          protectedAssets: assets.map((u) => u.ref),
          engagement: { allowCrush: true },
        }),
      );
    if (withdrawing.length)
      additionalCombat.push(
        this.mission("recover-force", {
          kind: "withdraw",
          units: withdrawing.map((u) => u.ref),
          destination: this.withdrawalPoint,
          objective: "regroup-after-unfavorable-contact",
          engagement: { allowCrush: false },
        }),
      );
    if (assault.length)
      additionalCombat.push(
        this.mission("reserve-force", {
          kind: responding ? "defend" : "assemble",
          units: reserve.map((u) => u.ref),
          destination: musterPost,
          objective: responding ? "protect-economy" : "muster-reinforcements",
          engagement: { allowCrush: true },
        }),
      );
    if (joiners.length)
      additionalCombat.push(
        this.mission("reinforcements", {
          kind: "advance",
          units: joiners.map((u) => u.ref),
          destination: assault.length ? center(assault) : post,
          objective: "join-main-force",
          engagement: { allowCrush: false },
        }),
      );
    if (income.mission)
      additionalCombat.push(this.mission(income.mission.id, income.mission));
    const screen = dogs.filter((u) => !this.scoutRefs.has(u.ref));
    if (screen.length) {
      const front = [...(assault.length ? assault : reserve)].sort(
        (a, b) =>
          distance2(a, operation?.point ?? stagingDirection) -
          distance2(b, operation?.point ?? stagingDirection),
      )[0];
      additionalCombat.push(
        this.mission("armor-screen", {
          kind: "screen",
          units: screen.map((u) => u.ref),
          destination: front
            ? {
                x: front.x,
                y: front.y,
                ...(front.onBridge === undefined
                  ? {}
                  : { onBridge: front.onBridge }),
              }
            : musterPost,
          objective: "screen-armor",
          engagement: { allowCrush: false },
        }),
      );
    }
    for (const scout of scouts) {
      const id = `recon-${scout.ref}`;
      additionalCombat.push(
        this.mission(id, {
          kind: "scout",
          units: [scout.ref],
          destination: this.recon.destination(o, [scout], feedback, id),
          objective: "reveal-approaches-and-enemy-base",
          engagement: { allowCrush: false },
        }),
      );
    }
    const decision =
      operation && assault.length
        ? {
            operationReason: operation.reason,
            formedTanks: assault.filter((u) => u.name === armor).length,
            defenders: operation.defenders,
            productionArrivals: operation.productionArrivals,
            travelSeconds: operation.travelSeconds,
            assumedProduction: operation.assumedProduction ?? false,
          }
        : this.operations.decision;
    return {
      tick: o.tick,
      combat,
      additionalCombat,
      production,
      decision: { ...decision, ...this.transition },
    };
  }
}
