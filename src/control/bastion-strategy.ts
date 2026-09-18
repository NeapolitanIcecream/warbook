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
import { Operations } from "./operations.js";
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
  private readonly recon = new Reconnaissance();
  private readonly revisions = new Map<string, TaskRevision>();
  private readonly productionRevision = new TaskRevision();
  private assault = new Set<string>();
  private joining = new Set<string>();
  private withdrawing = new Set<string>();
  private withdrawalPoint?: Point;
  private nextLaunchTick = 0;
  private readonly launchSize = 6;
  private firstForceFunded = false;
  private launchedArmor = 6;

  constructor(
    private readonly doctrine: "bastion" | "cohort" = "bastion",
    private readonly operations = new Operations(),
  ) {
    this.id =
      doctrine === "bastion" ? "bastion-strategy-v9" : "cohort-strategy-v5";
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
    if (assessment.observedArmor >= this.launchSize)
      this.firstForceFunded = true;
    const scouts = assessment.army.filter(isScout);
    const infantry = assessment.army.filter((u) => u.type === 3 && !isScout(u));
    const allVehicles = assessment.army.filter((u) => u.type !== 3);
    const alive = new Set(allVehicles.map((u) => u.ref));
    const hadAssault = this.assault.size > 0;
    this.assault = new Set([...this.assault].filter((ref) => alive.has(ref)));
    this.joining = new Set([...this.joining].filter((ref) => alive.has(ref)));
    const {
      direction,
      post,
      assets,
      incursions,
      guardIncursions,
      vehiclePost,
      protectNow,
      responding,
      damagedAt,
    } = this.situation.observe(o);
    const relief = this.relief.assign(
      o,
      allVehicles.filter((u) => !this.withdrawing.has(u.ref)),
      infantry,
      [...new Map(incursions.map((i) => [i.enemy.ref, i.enemy])).values()],
      vehiclePost,
      this.assault,
      protectNow && this.assault.size > 0,
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
    const musterPost = responding ? vehiclePost : stagingPost;
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
    const isReserve = (u: Unit) =>
      !this.assault.has(u.ref) &&
      !this.joining.has(u.ref) &&
      !this.withdrawing.has(u.ref);
    let assault = vehicles.filter((u) => this.assault.has(u.ref));
    if (
      hadAssault &&
      assault.filter((u) => u.name === armor).length <
        Math.min(3, this.launchedArmor)
    ) {
      beginWithdrawal();
      this.assault.clear();
      this.joining.clear();
      this.operations.active = undefined;
      assault = [];
      this.nextLaunchTick = o.tick + 450;
    }
    if (assault.length && !this.operations.target(o, assault)) {
      beginWithdrawal();
      this.assault.clear();
      this.joining.clear();
      assault = [];
    }
    let reserve = vehicles.filter(isReserve);
    const ready = formedUnits(
      reserve.filter(
        (u) => outsideFactory(u) && distance2(u, musterPost) <= 12 ** 2,
      ),
      musterPost,
    );
    const opportunity = this.operations.consider(o, ready);
    const exploration =
      !this.operations.hasKnownBase &&
      ready.filter((u) => u.name === armor).length >= this.launchSize &&
      base.combat.destination
        ? {
            point: base.combat.destination,
            reason: "formed-advance" as const,
            defenders: 0,
            productionArrivals: 0,
            travelSeconds: 0,
          }
        : undefined;
    const nextOperation = opportunity ?? exploration;
    if (
      !this.assault.size &&
      !protectNow &&
      o.tick >= this.nextLaunchTick &&
      nextOperation
    ) {
      this.assault = new Set(ready.map((u) => u.ref));
      this.launchedArmor = ready.filter((u) => u.name === armor).length;
      this.operations.active = nextOperation;
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
          (u) => outsideFactory(u) && distance2(u, musterPost) <= 12 ** 2,
        ),
        musterPost,
      );
      if (
        !this.joining.size &&
        nextBatch.filter((u) => u.name === armor).length >= 4
      )
        this.joining = new Set(nextBatch.map((u) => u.ref));
    }
    assault = vehicles.filter((u) => this.assault.has(u.ref));
    const joiners = vehicles.filter((u) => this.joining.has(u.ref));
    reserve = vehicles.filter(isReserve);
    const withdrawing = vehicles.filter((u) => this.withdrawing.has(u.ref));
    const fort = o.side === 0 ? "GAPILL" : "NALASR";
    const refinery = o.side === 0 ? "GAREFN" : "NAREFN";
    const mobilizing = !this.firstForceFunded;
    const economy = {
      ...base.production,
      scouts: {
        product: o.side === 0 ? "ADOG" : "DOG",
        count: o.starts.length > 2 ? 2 : 1,
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
    const operation = this.operations.target(o, assault);
    const combat = this.mission("main-force", {
      kind: assault.length
        ? "advance"
        : responding || protectNow
          ? "defend"
          : "assemble",
      units: (assault.length ? assault : reserve).map((u) => u.ref),
      destination: assault.length ? operation?.point : musterPost,
      groundDestination: assault.length ? operation?.point : musterPost,
      objective:
        protectNow && !assault.length
          ? "protect-base"
          : assault.length
            ? (operation?.reason ?? "reassess-operation")
            : responding
              ? "protect-economy"
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
            destination: vehiclePost,
            objective: "guard-base",
            protectedAssets: assets.map((u) => u.ref).sort(),
            approach: direction,
            engagement: { allowCrush: false },
          }),
        ];
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
    return { tick: o.tick, combat, additionalCombat, production, decision };
  }
}
