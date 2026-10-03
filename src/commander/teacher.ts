import { distance2, type Intent, type Observation } from "../model.js";
import { BastionStrategy } from "../control/bastion-strategy.js";
import { PressureStrategy } from "../control/pressure-strategy.js";
import { QueueProduction } from "../control/production.js";
import { committedStock } from "../control/program-production.js";
import {
  TaskRevision,
  type StrategicController,
  type StrategicPlan,
  type ProgramProductionPlan,
  type InventoryProductionPlan,
  type ControlReport,
  type TacticalAssessment,
  type CombatMission,
  type QueueProgram,
} from "../control/contracts.js";

export interface CommanderTeacherSource extends Omit<StrategicController, "plan"> {
  plan(o: Observation, assessment: TacticalAssessment, feedback?: ControlReport): StrategicPlan<InventoryProductionPlan>;
}
export interface CommanderTeacherOptions {
  source?: CommanderTeacherSource;
  sourceCadence?: "strategy75" | "every-observation";
  /** Opt-in for legal source anchors in bridge connectivity; default interface remains unchanged. */
  sourceGeometry?: boolean;
  /** Diagnostic teacher intervention; repeat uses the existing explicit program action. */
  productionPolicy?: "inventory-step" | "continuous-armor";
  /** Keep the source's chosen siege stock after a later armor loss. */
  siegeCommitment?: boolean;
  /** Stop pursuing armor into a visible deployed-infantry line while waiting for range. */
  defendedContactLine?: boolean;
  /** Pressure GI escort tasks select the intended armored front, not the later economic objective. */
  pressureEscortGoals?: boolean;
}

/** Express the pressure route's armored escort through a selectable own-unit
 * goal. Exposed economic attacks keep their selected enemy building. */
export class PressureEscortGoals {
  private revisions = new Map<string, TaskRevision>();
  control(o: Observation, mission: CombatMission, main: CombatMission): CombatMission {
    if (
      main.kind !== "advance" || mission.kind !== "advance" ||
      mission.objective !== "pressure-separate-economic-targets" ||
      !mission.destination || !mission.units.length ||
      !mission.units.every((ref) => o.own.some((u) => u.ref === ref && ["E1", "E2"].includes(u.name)))
    ) return mission;
    const front = o.own.find(
      (u) => u.type === 7 && u.combat && !u.harvester &&
        main.units.includes(u.ref) && distance2(u, mission.destination!) === 0,
    );
    if (!front || front.ref === mission.target) return mission;
    const selectedEnemy = o.enemies.find((e) => e.ref === mission.target);
    if (selectedEnemy && distance2(selectedEnemy, mission.destination) === 0) return mission;
    let revision = this.revisions.get(mission.id);
    if (!revision) this.revisions.set(mission.id, revision = new TaskRevision());
    const description = { ...mission, target: front.ref };
    return { ...description, revision: revision.update({ ...description, revision: undefined, units: [...mission.units].sort() }) };
  }
}

/** Diagnostic strategic choice expressed through the learner's existing defend
 * kind and own-unit goal. All contacts are currently visible actor observations. */
export class DefendedContactLine {
  private guard?: { anchor: string; lastContact: number };
  private revision = new TaskRevision();
  control(o: Observation, mission: CombatMission): CombatMission {
    const vehicles = o.own.filter(
      (u) => mission.units.includes(u.ref) && u.type === 7 && u.combat && !u.harvester,
    );
    if (mission.kind !== "advance" || !vehicles.length) {
      this.guard = undefined;
      return mission;
    }
    const center = {
      x: vehicles.reduce((n, u) => n + u.x, 0) / vehicles.length,
      y: vehicles.reduce((n, u) => n + u.y, 0) / vehicles.length,
    };
    if (o.own.some((u) => u.combat && (u.weaponRange ?? 0) >= 8 && distance2(u, center) <= 16 ** 2)) {
      this.guard = undefined;
      return mission;
    }
    const near = o.enemies.filter((e) => vehicles.some((u) => distance2(e, u) <= 12 ** 2));
    const defended =
      vehicles.length >= 5 &&
      near.filter((e) => e.name === "E1" && e.deployed && !e.airborne).length >= 3 &&
      near.filter((e) => ["MTNK", "HTNK"].includes(e.name) && !e.airborne).length >= 3;
    const anchor = vehicles.find((u) => u.ref === this.guard?.anchor) ??
      [...vehicles].sort((a, b) => distance2(a, center) - distance2(b, center))[0];
    if (defended) this.guard = { anchor: anchor.ref, lastContact: o.tick };
    if (!this.guard) return mission;
    if (o.tick - this.guard.lastContact > 300 && !near.some((e) => (e.weaponRange ?? 0) > 0 && !e.airborne)) {
      this.guard = undefined;
      return mission;
    }
    this.guard.anchor = anchor.ref;
    const description = {
      ...mission,
      kind: "defend" as const,
      destination: { x: anchor.x, y: anchor.y, ...(anchor.onBridge ? { onBridge: true } : {}) },
      groundDestination: { x: anchor.x, y: anchor.y, ...(anchor.onBridge ? { onBridge: true } : {}) },
      target: anchor.ref,
      objective: "hold-visible-defense-line-for-range",
    };
    return {
      ...description,
      revision: this.revision.update({ ...description, revision: undefined, units: [...mission.units].sort() }),
    };
  }
}

/** Keep a standing armor demand while the inventory teacher has no vehicle
 * replacement or technology funding priority. The learner's executor is unchanged. */
export function continuousArmorOrder(
  o: Observation,
  plan: InventoryProductionPlan,
  intents: readonly Intent[],
): QueueProgram | undefined {
  const v = plan.vehicles;
  const armor = o.products.find((p) => p.name === v.armor);
  if (!armor) return undefined;
  const requested = intents.find(
    (i) => i.kind === "queue" && i.product.queue === armor.queue,
  );
  if (requested?.kind === "queue" && requested.product.name !== armor.name)
    return undefined;
  const incomingMiner = intents.filter(
    (i) =>
      i.kind === "queue" &&
      (o.catalogue?.find((p) => p.name === i.product.name)?.grants ??
        ({ GAREFN: "CMIN", NAREFN: "HARV" } as Record<string, string>)[
          i.product.name
        ]) === v.harvester,
  ).length;
  const needsAntiAir =
    o.own.filter((u) => u.antiAir && u.mobile).length < v.mobileAntiAir;
  const needsHarvester =
    committedStock(o, v.harvester) + incomingMiner < v.harvesters;
  const needsSiege =
    v.siege && committedStock(o, v.siege.product) < v.siege.count;
  const fundingSiege =
    v.siege &&
    !o.products.some((p) => p.name === v.siege!.product) &&
    plan.structures.some(
      (g) =>
        (g.product === "GATECH" ||
          o.products.some((p) => p.name === g.product && p.radar)) &&
        o.own.filter((u) => u.name === g.product).length < g.count,
    );
  if (needsAntiAir || needsHarvester || needsSiege || fundingSiege)
    return undefined;
  return {
    queue: armor.queue,
    mode: "run",
    product: armor.name,
    target: -1,
    reserve: 0,
  };
}

export const COMMANDER_SCHEMA = "commander-v1";
export const STRATEGY_PERIOD = 75;

/** An active teacher executes the same explicit program interface as the learner.
 * Inventory heuristics are teacher decisions, never part of ProgramProduction. */
export class CommanderTeacher implements StrategicController {
  readonly id = "commander-teacher-v1";
  readonly observationScope = COMMANDER_SCHEMA;
  readonly period = STRATEGY_PERIOD;
  private teacher: CommanderTeacherSource;
  private advice?: StrategicPlan<InventoryProductionPlan>;
  private committedSiege?: InventoryProductionPlan["vehicles"]["siege"];
  private contactLine = new DefendedContactLine();
  private pressureEscorts = new PressureEscortGoals();
  private production = new QueueProduction();
  private revision = new TaskRevision();
  private last?: StrategicPlan<ProgramProductionPlan>;
  record?: {
    schema: string;
    tick: number;
    policy: string;
    observation: Observation;
    previous?: StrategicPlan<ProgramProductionPlan>;
    plan: StrategicPlan<ProgramProductionPlan>;
    inheritance?: { source: string; cadence: string; sourceGeometry: boolean; productionPolicy?: string; siegeCommitment?: boolean; committedSiege?: InventoryProductionPlan["vehicles"]["siege"]; defendedContactLine?: boolean; pressureEscortGoals?: boolean; sourceRecord?: unknown };
  };
  constructor(
    readonly route: "bastion" | "pressure",
    private readonly options: CommanderTeacherOptions = {},
  ) {
    this.teacher = options.source ?? (route === "pressure" ? new PressureStrategy() : new BastionStrategy());
  }
  get sourcePlan() { return this.advice; }
  get sourceRecord() { return this.teacher.launchRecord; }
  launchPoints() { return this.options.sourceGeometry ? this.teacher.launchPoints?.() ?? [] : []; }
  get launchRecord() {
    return this.record;
  }
  assessmentRequest(o: Observation) {
    return this.teacher.assessmentRequest(o);
  }
  plan(
    o: Observation,
    assessment: TacticalAssessment,
    feedback?: ControlReport,
  ): StrategicPlan<ProgramProductionPlan> {
    // A learned source needs each real observation to consume confirmed departures,
    // visible target motion and arrivals between its 75-tick decision steps.
    // The default keeps the existing rule-teacher clock exactly as before.
    if (this.options.sourceCadence === "every-observation" || o.tick % this.period === 0) {
      this.advice = this.teacher.plan(o, assessment, feedback);
      if (this.options.siegeCommitment && this.advice.production.vehicles.siege)
        this.committedSiege = { ...this.advice.production.vehicles.siege };
    }
    if (o.tick % this.period === 0) {
      const source = this.advice!;
      const productionAdvice = this.options.siegeCommitment && this.committedSiege
        ? {
            ...source,
            production: {
              ...source.production,
              vehicles: { ...source.production.vehicles, siege: this.committedSiege },
            },
          }
        : source;
      const combatAdvice = this.options.defendedContactLine
        ? { ...productionAdvice, combat: this.contactLine.control(o, productionAdvice.combat) }
        : productionAdvice;
      const advice = this.options.pressureEscortGoals && this.route === "pressure"
        ? { ...combatAdvice, additionalCombat: combatAdvice.additionalCombat?.map((m) => this.pressureEscorts.control(o, m, productionAdvice.combat)) }
        : combatAdvice;
      const intents = this.production.control(o, advice.production, []).intents;
      const queues: QueueProgram[] = o.queues.map((q) => {
        const request = intents.find(
          (i) => i.kind === "queue" && i.product.queue === q.type,
        );
        if (request?.kind === "queue")
          return {
            queue: q.type,
            mode: "run" as const,
            product: request.product.name,
            target: committedStock(o, request.product.name) + 1,
            reserve: 0,
          };
        // Existing production is allowed to finish. An empty queue has no standing demand.
        return {
          queue: q.type,
          mode: "run" as const,
          product: q.items[0]?.name,
          target: 0,
          reserve: 0,
        };
      });
      if (this.options.productionPolicy === "continuous-armor") {
        const armor = continuousArmorOrder(o, advice.production, intents);
        if (armor) {
          const i = queues.findIndex((q) => q.queue === armor.queue);
          if (i >= 0) queues[i] = armor;
        }
      }
      const program = {
        queues,
        placements: intents.flatMap((i) =>
          i.kind === "place" ? [{ name: i.name, x: i.x, y: i.y }] : [],
        ),
        repair: [
          ...new Set([
            ...o.own.filter((u) => u.hasWrenchRepair).map((u) => u.ref),
            ...intents.flatMap((i) => (i.kind === "repair" ? [i.ref] : [])),
          ]),
        ],
        sell: [] as string[],
      };
      const previous = this.last;
      this.last = {
        ...advice,
        production: {
          id: "commander-production",
          revision: this.revision.update(program),
          deploymentUnits: advice.production.deploymentUnits,
          program,
        },
      };
      this.record = {
        schema: COMMANDER_SCHEMA,
        tick: o.tick,
        policy: `teacher-${this.route}`,
        observation: o,
        previous,
        plan: this.last,
        ...(this.options.source ? { inheritance: {
          source: this.teacher.id,
          cadence: this.options.sourceCadence ?? "strategy75",
          sourceGeometry: !!this.options.sourceGeometry,
          ...(this.options.productionPolicy ? { productionPolicy: this.options.productionPolicy } : {}),
          ...(this.options.siegeCommitment ? { siegeCommitment: true, committedSiege: this.committedSiege } : {}),
          ...(this.options.defendedContactLine ? { defendedContactLine: true } : {}),
          ...(this.options.pressureEscortGoals ? { pressureEscortGoals: true } : {}),
          sourceRecord: this.teacher.launchRecord,
        } } : {}),
      };
    }
    const live = new Set(o.own.map((u) => u.ref));
    const clean = (m: CombatMission) => ({
      ...m,
      units: m.units.filter((u) => live.has(u)),
    });
    return this.last
      ? {
          ...this.last,
          tick: o.tick,
          combat: clean(this.last.combat),
          additionalCombat: this.last.additionalCombat?.map(clean),
          production: {
            ...this.last.production,
            deploymentUnits: this.last.production.deploymentUnits.filter((u) =>
              live.has(u),
            ),
          },
        }
      : {
          tick: o.tick,
          combat: {
            id: "unassigned",
            revision: 0,
            kind: "assemble",
            units: [],
            objective: "await-strategy-clock",
            engagement: { allowCrush: false },
          },
          production: {
            id: "commander-production",
            revision: 0,
            deploymentUnits: [],
            program: { queues: [], placements: [], repair: [], sell: [] },
          },
        };
  }
}
