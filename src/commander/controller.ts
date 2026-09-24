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
import type {
  CommanderEncoding,
  EncodedCommanderAction as CommanderAction,
} from "./action-mask.js";
import {
  buildWorld,
  ContactMemory,
  DEPLOY,
  RESERVE,
  type CommanderWorld,
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
  readonly encoding?: CommanderEncoding;
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
  encoding: CommanderEncoding;
  tick: number;
  world: CommanderWorld;
  action: CommanderAction;
  logp: number;
  value: number;
  entropy: number;
  hidden: number[];
  executionSource: "teacher" | "policy";
  /** Expert label at the learner's actual state; never substituted in PPO. */
  teacherAction?: CommanderAction;
  projectionMaximum?: number;
}
/** Owns all strategic plans. In policy-only runs no legacy strategy is constructed. */
export class FullCommander implements StrategicController {
  readonly id = "full-commander-v1";
  readonly observationScope = "commander-v1" as const;
  private program: ProgramController;
  get encoding() {
    return this.program.encoding;
  }
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
    private daggerBeta?: number,
  ) {
    this.program = new ProgramController(policy?.encoding ?? "graph-plan-v2");
    if (
      daggerBeta !== undefined &&
      (!policy ||
        !Number.isFinite(daggerBeta) ||
        daggerBeta < 0 ||
        daggerBeta > 1)
    )
      throw new Error("DAgger requires a policy and beta in [0,1]");
    if (!policy || prefixUntil > 0 || daggerBeta !== undefined)
      this.teacher = new CommanderTeacher(route);
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
      const teacher =
        !this.policy ||
        o.tick < this.prefixUntil ||
        (this.daggerBeta !== undefined && this.random() < this.daggerBeta);
      const teacherAction =
        teacher || this.daggerBeta !== undefined
          ? this.program.teacherAction(
              o,
              world,
              this.teacher!.plan(o, assessment, feedback),
            )
          : undefined;
      let action: CommanderAction,
        logp = 0,
        value = 0,
        entropy = 0;
      if (teacher) {
        action = teacherAction!;
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
        encoding: this.encoding,
        tick: o.tick,
        world,
        action,
        logp,
        value,
        entropy,
        hidden,
        executionSource: teacher ? "teacher" : "policy",
        ...(this.daggerBeta !== undefined ? { teacherAction } : {}),
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
