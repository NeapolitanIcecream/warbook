import type { OperationProvider } from "./operation-provider.js";
import {
  observeArmor,
  applyOperation,
  applyLaunchOnly,
  syncLegacyOrder,
  describeOperation,
  operationGroups,
} from "./operation-state.js";
import {
  planLegacyArmor,
  assignMiningGuards,
  initialArmorFlank,
  contactArmorFlank,
  type LegacyArmorFrame,
} from "./legacy-armor.js";
import { armorState, authorizedArmor, copyArmorState } from "./armor-state.js";
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
import { rendezvous } from "./formation.js";
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
  private armor = armorState();
  private readonly launchSize = 6;
  private firstForceFunded = false;
  private producedArmor = new Set<string>();
  private resourcePost?: Point;
  private readonly mining = new MiningArea();
  private scoutRefs = new Set<string>();
  private developSiege = false;
  private operationReliefRefs = new Set<string>();
  private operationAnchors: Point[] = [];

  constructor(
    private readonly doctrine: "bastion" | "cohort" = "bastion",
    private readonly launchProvider?: LaunchProvider,
    private readonly operationProvider?: OperationProvider,
  ) {
    this.id =
      doctrine === "bastion" ? "bastion-strategy-v11" : "cohort-strategy-v6";
  }
  get launchRecord() {
    return this.operationProvider?.record ?? this.launchProvider?.record;
  }
  launchPoints(): readonly Point[] {
    return this.launchProvider || this.operationProvider
      ? [
          ...this.operations.contacts.filter(
            (e) => e.type === 2 || ["AMCV", "SMCV"].includes(e.name),
          ),
          ...this.operationAnchors,
          ...(this.armor.order ? [this.armor.order.goal.point] : []),
        ]
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
      (u) => this.armor.assault.has(u.ref) && !this.armor.flankRefs.has(u.ref),
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
    const hadAssault = this.armor.assault.size > 0;
    if (this.operationProvider) observeArmor(this.armor, o);
    else {
      this.armor.assault = new Set(
        [...this.armor.assault].filter((ref) => alive.has(ref)),
      );
      this.armor.joining = new Set(
        [...this.armor.joining].filter((ref) => alive.has(ref)),
      );
    }
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
    const experimentalLaunch =
      this.launchProvider?.experimental ||
      (this.operationProvider?.scope === "launch" &&
        !this.operationProvider.teacher);
    const freshDefense =
      !experimentalLaunch ||
      incursions.some(
        (i) =>
          !this.armor.launchThreats.has(`${i.enemy.ref}:${i.asset.ref}`) ||
          (damagedAt.get(i.asset.ref) ?? -Infinity) > this.armor.launchTick,
      );
    const decisionStep =
      !!this.operationProvider && o.tick % this.operationProvider.period === 0;
    const localThreats = [
      ...new Map(incursions.map((i) => [i.enemy.ref, i.enemy])).values(),
    ];
    const ruleRelief = decisionStep ? this.relief.planningCopy() : undefined;
    const suggestedRelief =
      ruleRelief?.assign(
        o,
        allVehicles.filter(
          (u) =>
            !this.armor.withdrawing.has(u.ref) &&
            (freshDefense || !this.armor.assault.has(u.ref)),
        ),
        infantry,
        localThreats,
        vehiclePost,
        this.armor.assault,
        responding && this.armor.assault.size > 0 && freshDefense,
      ) ?? [];
    const owned = authorizedArmor(this.armor);
    const delegated =
      this.operationProvider &&
      (this.operationProvider.teacher ||
        this.operationProvider.scope === "launch");
    let relief = delegated
      ? allVehicles.filter((u) => this.operationReliefRefs.has(u.ref))
      : this.relief.assign(
          o,
          allVehicles.filter((u) =>
            this.operationProvider
              ? !owned.has(u.ref)
              : !this.armor.withdrawing.has(u.ref) &&
                (freshDefense || !this.armor.assault.has(u.ref)),
          ),
          infantry,
          localThreats,
          vehiclePost,
          this.armor.assault,
          responding &&
            this.armor.assault.size > 0 &&
            (this.operationProvider ? true : freshDefense),
        );
    let reliefRefs = new Set(relief.map((u) => u.ref));
    if (!this.operationProvider)
      for (const ref of reliefRefs) {
        this.armor.assault.delete(ref);
        this.armor.joining.delete(ref);
      }
    let vehicles = allVehicles.filter((u) => !reliefRefs.has(u.ref));
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
    const frame: LegacyArmorFrame = {
      o,
      vehicles,
      armor,
      post,
      musterPost,
      stagingDirection,
      workingField,
      resourcePost: this.resourcePost,
      protectNow,
      firstForceFunded: this.firstForceFunded,
      hasScouts: !!scouts.length,
      searchGoal,
      launchSize: this.launchSize,
      hadAssault,
      threatKeys: incursions.map((i) => `${i.enemy.ref}:${i.asset.ref}`),
      feedback,
      outsideFactory,
      covered,
    };
    let planned;
    if (!this.operationProvider)
      planned = planLegacyArmor(
        this.armor,
        this.operations,
        this.launchProvider ?? this.legacyLaunch,
        frame,
      );
    else {
      assignMiningGuards(this.armor, frame);
      const anchors = {
        assemble: [musterPost, o.baseRally ?? post],
        defend: [vehiclePost, this.resourcePost ?? post],
        withdraw: [o.baseRally ?? post, musterPost],
      };
      this.operationAnchors = Object.values(anchors).flat();
      if (decisionStep) {
        let delegatedChange:
          | {
              source: "fixed-rule";
              added: string[];
              released: string[];
              orderChanged: boolean;
            }
          | undefined;
        const advisedVehicles = allVehicles.filter(
          (u) => !suggestedRelief.some((r) => r.ref === u.ref),
        );
        const advise = (launch: LaunchProvider) => {
          const state = copyArmorState(this.armor),
            operations = this.operations.planningCopy();
          for (const u of suggestedRelief) {
            state.assault.delete(u.ref);
            state.joining.delete(u.ref);
          }
          // This copy is a proposal from the current actual state, never a shadow trajectory.
          planLegacyArmor(state, operations, launch, {
            ...frame,
            vehicles: advisedVehicles,
          });
          syncLegacyOrder(state, operations, o.tick);
          return {
            state,
            operations,
            recalled: suggestedRelief
              .filter((u) => owned.has(u.ref))
              .map((u) => u.ref),
          };
        };
        if (this.operationProvider.scope === "launch") {
          const priorMembers = authorizedArmor(this.armor),
            priorOrder = this.armor.order;
          const continuation = advise({ choose: () => undefined });
          const nextMembers = authorizedArmor(continuation.state);
          delegatedChange = {
            source: "fixed-rule",
            added: [...nextMembers].filter((r) => !priorMembers.has(r)),
            released: [...priorMembers].filter((r) => !nextMembers.has(r)),
            orderChanged:
              priorOrder?.kind !== continuation.state.order?.kind ||
              priorOrder?.goal.key !== continuation.state.order?.goal.key,
          };
          this.armor = continuation.state;
          this.operations.commitPlan(continuation.operations);
          this.relief.commitPlan(ruleRelief!);
          relief = suggestedRelief;
          reliefRefs = new Set(relief.map((u) => u.ref));
          this.operationReliefRefs = reliefRefs;
          vehicles = advisedVehicles;
        }
        const advice = advise(this.legacyLaunch);
        const reserve = operationGroups(this.armor, vehicles).reserve;
        const action = this.operationProvider.choose({
          observation: o,
          state: this.armor,
          operations: this.operations,
          reserve,
          anchors,
          frame: { ...frame, vehicles },
          advice,
          delegatedChange,
          feedback,
        });
        if (this.operationProvider.teacher) {
          this.armor = advice.state;
          this.operations.commitPlan(advice.operations);
          this.relief.commitPlan(ruleRelief!);
          relief = suggestedRelief;
          reliefRefs = new Set(relief.map((u) => u.ref));
          this.operationReliefRefs = reliefRefs;
          vehicles = advisedVehicles;
        } else {
          const newForce =
            this.operationProvider.scope === "launch"
              ? !this.armor.assault.size && !this.armor.joining.size
              : !authorizedArmor(this.armor).size;
          if (this.operationProvider.scope === "launch")
            applyLaunchOnly(this.armor, action, o, reserve);
          else applyOperation(this.armor, action, o, reserve);
          if (
            newForce &&
            action.kind === "apply" &&
            this.operationProvider.scope === "launch"
          ) {
            this.armor.heldForWave = new Set(
              reserve
                .filter((u) => !action.addRefs.includes(u.ref))
                .map((u) => u.ref),
            );
            this.armor.launchThreats = new Set(frame.threatKeys);
            this.armor.launchTick = o.tick;
          }
          if (action.kind === "apply")
            describeOperation(this.armor, this.operations, o);
        }
      }
      const operation =
        this.operationProvider.teacher ||
        this.operationProvider.scope === "launch"
          ? this.operations.active
          : describeOperation(this.armor, this.operations, o);
      planned = { ...operationGroups(this.armor, vehicles), operation };
    }
    if (
      this.operationProvider &&
      !this.operationProvider.teacher &&
      this.armor.order?.kind === "advance"
    ) {
      const alternative =
        o.flankApproach &&
        distance2(o.flankApproach.towards, this.armor.order.goal.point) <=
          10 ** 2
          ? o.flankApproach.point
          : undefined;
      if (
        this.armor.lastCommit?.tick === o.tick &&
        this.armor.lastCommit.orderChanged &&
        planned.operation
      )
        planned.operation = this.operations.active = initialArmorFlank(
          this.armor,
          planned.operation,
          planned.assault,
          armor,
          alternative,
          o.tick,
        );
      if (decisionStep)
        contactArmorFlank(
          this.armor,
          planned.assault,
          armor,
          alternative,
          feedback,
          o.tick,
        );
    }
    const { assault, joiners, withdrawing, reserve, mineGuards, operation } =
      planned;
    const controlledOrder =
      this.operationProvider?.scope === "operation" &&
      !this.operationProvider.teacher
        ? this.armor.order
        : undefined;
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

    for (const ref of this.armor.flankRefs)
      if (!this.armor.assault.has(ref)) this.armor.flankRefs.delete(ref);
    let flank = assault.filter((u) => this.armor.flankRefs.has(u.ref));
    if (flank.length === assault.length) {
      this.armor.flankRefs.clear();
      flank = [];
    }
    if (
      !flank.length ||
      (this.armor.flankVia &&
        distance2(center(flank), this.armor.flankVia) <= 6 ** 2)
    )
      this.armor.flankVia = undefined;
    const primary = assault.filter((u) => !this.armor.flankRefs.has(u.ref));
    const combat = this.mission("main-force", {
      kind:
        controlledOrder?.kind ??
        (assault.length
          ? "advance"
          : responding || protectNow
            ? "defend"
            : "assemble"),
      units: (controlledOrder
        ? controlledOrder.kind === "advance"
          ? primary
          : [...assault, ...joiners, ...withdrawing]
        : assault.length
          ? primary
          : reserve
      ).map((u) => u.ref),
      destination:
        controlledOrder?.goal.point ??
        (assault.length ? operation?.point : musterPost),
      groundDestination:
        controlledOrder?.goal.point ??
        (assault.length ? operation?.point : musterPost),
      objective: controlledOrder
        ? `policy-${controlledOrder.kind}`
        : protectNow && !assault.length
          ? "protect-base"
          : assault.length
            ? (operation?.reason ?? "reassess-operation")
            : responding
              ? "protect-economy"
              : this.resourcePost && this.firstForceFunded
                ? "hold-mining-approach"
                : "muster-counterattack",
      engagement: { allowCrush: controlledOrder?.kind !== "withdraw" },
      protectedAssets:
        controlledOrder?.kind === "defend"
          ? guardAssets.map((u) => u.ref)
          : undefined,
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
          destination: this.armor.flankVia ?? operation?.point,
          objective: this.armor.flankVia
            ? "approach-other-entrance"
            : "flank-defended-base",
          ...(!this.armor.flankVia && operation?.ref
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
    if (withdrawing.length && controlledOrder?.kind !== "withdraw")
      additionalCombat.push(
        this.mission("recover-force", {
          kind: "withdraw",
          units: withdrawing.map((u) => u.ref),
          destination: this.armor.withdrawalPoint,
          objective: "regroup-after-unfavorable-contact",
          engagement: { allowCrush: false },
        }),
      );
    if (assault.length || controlledOrder)
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
      decision: { ...decision, ...this.armor.transition },
    };
  }
}
