import type { Intent, Observation, Point, Unit } from "../model.js";

export interface TaskIdentity {
  readonly id: string;
  readonly revision: number;
}
export interface CombatMission extends TaskIdentity {
  readonly kind: "assemble" | "advance" | "defend";
  readonly units: readonly string[];
  /** Undefined means preserve existing orders; it does not send Stop. */
  readonly destination?: Point;
  readonly groundDestination?: Point;
  readonly objective: string;
  /** Owned objects whose attackers may be pursued by this defense mission. */
  readonly protectedAssets?: readonly string[];
  readonly engagement: {
    /** Permission for explicit crushing orders; native incidental movement effects are separate. */
    readonly allowCrush: boolean;
  };
}
export interface ProductionPlan extends TaskIdentity {
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
  };
  readonly infantry: { readonly product: string; readonly count: number };
  /** Preserve the existing pay-as-you-build start gates; not a full reservation ledger. */
  readonly spending: {
    readonly queueStartFloor: number;
    readonly infantryAbove: number;
  };
}
export interface StrategicPlan {
  readonly tick: number;
  readonly combat: CombatMission;
  readonly additionalCombat?: readonly CombatMission[];
  readonly production: ProductionPlan;
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
  assessmentRequest(observation: Observation): AssessmentRequest;
  plan(
    observation: Observation,
    assessment: TacticalAssessment,
    feedback?: ControlReport,
  ): StrategicPlan;
}
export interface TacticalController {
  readonly id: string;
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
