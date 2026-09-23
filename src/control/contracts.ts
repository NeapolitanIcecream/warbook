import type { Intent, Observation, Point, Unit } from "../model.js";

export interface TaskIdentity {
  readonly id: string;
  readonly revision: number;
}
export interface CombatMission extends TaskIdentity {
  readonly kind:
    | "hold"
    | "assemble"
    | "advance"
    | "defend"
    | "scout"
    | "withdraw"
    | "capture"
    | "harvest"
    | "screen";
  readonly units: readonly string[];
  /** Undefined means preserve existing orders; it does not send Stop. */
  readonly destination?: Point;
  readonly groundDestination?: Point;
  readonly objective: string;
  /** Preferred visible objective; native attacks still require current visibility. */
  readonly target?: string;
  /** Owned objects whose attackers may be pursued by this defense mission. */
  readonly protectedAssets?: readonly string[];
  /** A known approach direction for an explored-terrain staging request. */
  readonly approach?: Point;
  /** Currently visible contacts assigned to this defense group; absent for area guard. */
  readonly threats?: readonly string[];
  readonly engagement: {
    /** Permission for explicit crushing orders; native incidental movement effects are separate. */
    readonly allowCrush: boolean;
    /** An urgent reassignment may interrupt an otherwise useful nearby engagement. */
    readonly interrupt?: boolean;
  };
}
export interface InventoryProductionPlan extends TaskIdentity {
  readonly deploymentUnits: readonly string[];
  readonly power: { readonly product: string; readonly margin: number };
  readonly structures: readonly { product: string; count: number }[];
  /** Separately queued armory items; absent for the historical opening. */
  readonly defenses?: readonly { product: string; count: number }[];
  /** Preferred defensive position; the bridge still checks only explored legal footprints. */
  readonly defenseAnchor?: Point;
  readonly vehicles: {
    readonly armor: string;
    readonly harvester: string;
    readonly harvesters: number;
    readonly antiAir: string;
    readonly mobileAntiAir: number;
    readonly siege?: { readonly product: string; readonly count: number };
  };
  readonly infantry: { readonly product: string; readonly count: number };
  readonly engineers?: { readonly product: string; readonly count: number };
  readonly scouts?: {
    readonly product: string;
    readonly count: number;
    readonly required?: number;
  };
  /** Preserve the existing pay-as-you-build start gates; not a full reservation ledger. */
  readonly spending: {
    readonly queueStartFloor: number;
    readonly infantryAbove: number;
  };
}
export interface QueueProgram {
  queue: number;
  mode: "run" | "pause" | "cancel";
  product?: string;
  /** Desired committed stock; -1 means repeat until the strategy changes it. */
  target: number;
  /** Explicit cash floor. Zero permits the native pay-as-you-build behavior. */
  reserve: number;
}
export interface ProgramProductionPlan extends TaskIdentity {
  readonly deploymentUnits: readonly string[];
  readonly program: {
    /** Order is the strategy's submission priority, not an executor preference. */
    queues: readonly QueueProgram[];
    placements: readonly { name: string; x: number; y: number }[];
    repair: readonly string[];
    sell: readonly string[];
  };
}
export type ProductionPlan = InventoryProductionPlan | ProgramProductionPlan;
export interface StrategicPlan<P extends ProductionPlan = ProductionPlan> {
  readonly tick: number;
  readonly combat: CombatMission;
  readonly additionalCombat?: readonly CombatMission[];
  readonly production: P;
  /** Compact reasons for the current operational choice, for replay diagnosis. */
  readonly decision?: Readonly<Record<string, number | string | boolean>>;
}
export interface TacticalAssessment {
  readonly army: readonly Unit[];
  readonly observedArmor: number;
  readonly armorOutsideFactories: number;
}
export interface AssessmentRequest {
  readonly unitType: string;
  readonly factoryType: string;
}
export interface IntentOrigin extends TaskIdentity {
  readonly controller: "tactics" | "production";
}
export interface ExecutionEvidence {
  readonly origin: IntentOrigin;
  readonly intentId: string;
  readonly basedOnTick: number;
  readonly observedTick: number;
  readonly effect?: string;
  readonly unresolved: boolean;
}
export interface TaskReport {
  readonly task: TaskIdentity;
  readonly status: "idle" | "active" | "waiting" | "blocked";
  readonly reason: string;
  readonly proposedIntents: number;
  readonly facts: Readonly<Record<string, number | string | boolean>>;
  readonly executionEvidence: readonly ExecutionEvidence[];
}
export interface ControlResult {
  readonly origin: IntentOrigin;
  readonly intents: readonly Intent[];
  readonly report: TaskReport;
}
export interface ControlReport {
  readonly tick: number;
  readonly components: {
    strategy: string;
    tactics: string;
    production: string;
  };
  readonly combat: TaskReport;
  readonly additionalCombat?: readonly TaskReport[];
  readonly production: TaskReport;
}
export interface StrategicController {
  readonly id: string;
  readonly observationScope?: "commander-v1";
  readonly launchRecord?: unknown;
  launchPoints?(): readonly Point[];
  assessmentRequest(observation: Observation): AssessmentRequest;
  plan(
    observation: Observation,
    assessment: TacticalAssessment,
    feedback?: ControlReport,
  ): StrategicPlan;
}
export interface TacticalController {
  readonly id: string;
  readonly records?: readonly unknown[];
  assess(
    observation: Observation,
    request: AssessmentRequest,
  ): TacticalAssessment;
  control(
    observation: Observation,
    mission: CombatMission,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult;
}
export interface ProductionController {
  readonly id: string;
  control(
    observation: Observation,
    plan: ProductionPlan,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult;
}
export interface ControlComponents {
  strategy: StrategicController;
  tactics: TacticalController;
  production: ProductionController;
}

/** Revisions change on assignment/goal changes, not the order of the observation list. */
export class TaskRevision {
  private signature?: string;
  private revision = 0;
  update(description: unknown): number {
    const signature = JSON.stringify(description);
    if (signature !== this.signature) {
      this.signature = signature;
      this.revision++;
    }
    return this.revision;
  }
}

export const currentEvidence = (
  task: TaskIdentity,
  evidence: readonly ExecutionEvidence[],
) =>
  evidence.filter(
    (e) => e.origin.id === task.id && e.origin.revision === task.revision,
  );
