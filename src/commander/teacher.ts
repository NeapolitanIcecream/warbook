import type { Observation } from "../model.js";
import { BastionStrategy } from "../control/bastion-strategy.js";
import { PressureStrategy } from "../control/pressure-strategy.js";
import { QueueProduction } from "../control/production.js";
import { committedStock } from "../control/program-production.js";
import {
  TaskRevision,
  type StrategicController,
  type StrategicPlan,
  type ProgramProductionPlan,
  type ControlReport,
  type TacticalAssessment,
  type CombatMission,
} from "../control/contracts.js";

export const COMMANDER_SCHEMA = "commander-v1";
export const STRATEGY_PERIOD = 75;

/** An active teacher executes the same explicit program interface as the learner.
 * Inventory heuristics are teacher decisions, never part of ProgramProduction. */
export class CommanderTeacher implements StrategicController {
  readonly id = "commander-teacher-v1";
  readonly observationScope = COMMANDER_SCHEMA;
  readonly period = STRATEGY_PERIOD;
  private teacher: BastionStrategy | PressureStrategy;
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
  };
  constructor(readonly route: "bastion" | "pressure") {
    this.teacher =
      route === "pressure" ? new PressureStrategy() : new BastionStrategy();
  }
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
    if (o.tick % this.period === 0) {
      const advice = this.teacher.plan(o, assessment, feedback);
      const intents = this.production.control(o, advice.production, []).intents;
      const queues = o.queues.map((q) => {
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
