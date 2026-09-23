import seedrandom from "seedrandom";
import type { Observation } from "../model.js";
import type {
  StrategicController,
  StrategicPlan,
  ProgramProductionPlan,
  ControlReport,
  TacticalAssessment,
} from "../control/contracts.js";
import {
  CommanderTeacher,
  STRATEGY_PERIOD,
  COMMANDER_SCHEMA,
} from "./teacher.js";
import { ProgramController } from "./program.js";
import {
  buildWorld,
  ContactMemory,
  DEPLOY,
  RESERVE,
  type CommanderWorld,
  type CommanderAction,
} from "./world.js";

export interface CommanderPrediction {
  action: CommanderAction;
  logp: number;
  value: number;
  entropy: number;
  hidden: number[];
  probabilities?: Record<string, number[][]>;
}
export interface CommanderPolicy {
  readonly hiddenSize: number;
  predict(
    world: CommanderWorld,
    hidden: readonly number[],
    random: () => number,
    deterministic: boolean,
    forced?: CommanderAction,
  ): CommanderPrediction;
}
export interface CommanderRecord {
  schema: typeof COMMANDER_SCHEMA;
  encoding: "graph-plan-v1";
  tick: number;
  world: CommanderWorld;
  action: CommanderAction;
  logp: number;
  value: number;
  entropy: number;
  hidden: number[];
  executionSource: "teacher" | "policy";
  projectionMaximum?: number;
}
/** Owns all strategic plans. In policy-only runs no legacy strategy is constructed. */
export class FullCommander implements StrategicController {
  readonly id = "full-commander-v1";
  readonly observationScope = "commander-v1" as const;
  private program = new ProgramController();
  private memory = new ContactMemory();
  private teacher?: CommanderTeacher;
  private random: () => number;
  private hidden: number[];
  record?: CommanderRecord;
  constructor(
    readonly route: "bastion" | "pressure",
    private policy?: CommanderPolicy,
    seed = "0",
    private deterministic = false,
    private prefixUntil = 0,
  ) {
    if (!policy || prefixUntil > 0) this.teacher = new CommanderTeacher(route);
    this.hidden = Array(policy?.hiddenSize ?? 128).fill(0);
    this.random = seedrandom(seed);
  }
  get launchRecord() {
    return this.record;
  }
  assessmentRequest(o: Observation) {
    return o.side === 0
      ? { unitType: "MTNK", factoryType: "GAWEAP" }
      : { unitType: "HTNK", factoryType: "NAWEAP" };
  }
  plan(
    o: Observation,
    assessment: TacticalAssessment,
    feedback?: ControlReport,
  ): StrategicPlan<ProgramProductionPlan> {
    this.memory.observe(o);
    for (const ref of o.ownDepartures ?? [])
      this.program.state.roles.delete(ref);
    if (o.tick % STRATEGY_PERIOD === 0) {
      // Deploy is a request for one transformation, not an endless deploy/repack loop.
      for (const [ref, role] of this.program.state.roles)
        if (role === DEPLOY) this.program.state.roles.set(ref, RESERVE);
      const world = buildWorld(o, this.program.state, this.memory),
        hidden = [...this.hidden];
      const teacher = !this.policy || o.tick < this.prefixUntil;
      let action: CommanderAction,
        logp = 0,
        value = 0,
        entropy = 0;
      if (teacher) {
        const desired = this.teacher!.plan(o, assessment, feedback);
        action = this.program.teacherAction(o, world, desired);
        if (this.policy) {
          const p = this.policy.predict(
            world,
            hidden,
            this.random,
            this.deterministic,
            action,
          );
          this.hidden = p.hidden;
          value = p.value;
        }
      } else {
        const p = this.policy!.predict(
          world,
          hidden,
          this.random,
          this.deterministic,
        );
        action = p.action;
        logp = p.logp;
        value = p.value;
        entropy = p.entropy;
        this.hidden = p.hidden;
      }
      this.program.apply(o, world, action);
      this.record = {
        schema: COMMANDER_SCHEMA,
        encoding: "graph-plan-v1",
        tick: o.tick,
        world,
        action,
        logp,
        value,
        entropy,
        hidden,
        executionSource: teacher ? "teacher" : "policy",
        ...(teacher
          ? {
              projectionMaximum: Math.max(
                0,
                ...this.program.projectionDistances,
              ),
            }
          : {}),
      };
    }
    return this.program.plan(o);
  }
}
