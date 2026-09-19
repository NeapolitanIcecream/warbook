import type { Intent, Observation } from "./model.js";
import { LegacyCommander } from "./legacy-policy.js";
import { ControlCoordinator } from "./control/coordinator.js";
import { BastionStrategy } from "./control/bastion-strategy.js";
import { PositionTactics } from "./control/position-tactics.js";
import { PressureStrategy } from "./control/pressure-strategy.js";
import type {
  ControlComponents,
  ExecutionEvidence,
} from "./control/contracts.js";

export const POLICY_VERSION = "warbook-0.1.15-dev.7";
export type PolicyMode =
  | "baseline"
  | "cohesive"
  | "guarded"
  | "pillbox"
  | "sentry"
  | "crush"
  | "tempo"
  | "combined"
  | "raid"
  | "counter"
  | "coordinated"
  | "assembly-only"
  | "formed"
  | "factory-exit"
  | "bastion"
  | "pressure"
  | "cohort-local"
  | "contact-filter";
export const POLICY_MODES: readonly PolicyMode[] = [
  "baseline",
  "cohesive",
  "guarded",
  "pillbox",
  "sentry",
  "crush",
  "tempo",
  "combined",
  "raid",
  "counter",
  "coordinated",
  "assembly-only",
  "formed",
  "factory-exit",
  "bastion",
  "pressure",
  "cohort-local",
  "contact-filter",
];

/** Current policy uses replaceable task controllers; historical modes retain their original implementation. */
export class Commander {
  private readonly legacy?: LegacyCommander;
  private readonly control?: ControlCoordinator;
  constructor(
    readonly mode: PolicyMode = "baseline",
    components?: Partial<ControlComponents>,
  ) {
    if (mode === "factory-exit")
      this.control = new ControlCoordinator(components);
    else if (mode === "pressure")
      this.control = new ControlCoordinator({
        strategy: new PressureStrategy(),
        tactics: new PositionTactics(),
        ...components,
      });
    else if (mode === "bastion")
      this.control = new ControlCoordinator({
        strategy: new BastionStrategy(),
        tactics: new PositionTactics(),
        ...components,
      });
    else if (mode === "cohort-local")
      this.control = new ControlCoordinator({
        strategy: new BastionStrategy("cohort"),
        tactics: new PositionTactics(),
        ...components,
      });
    else {
      if (components)
        throw new Error("Layer replacement requires a layered policy mode");
      this.legacy = new LegacyCommander(mode);
    }
  }
  decide(o: Observation): Intent[] {
    return this.control ? this.control.decide(o) : this.legacy!.decide(o);
  }
  get controlReport() {
    return this.control?.report;
  }
  get controlPlan() {
    return this.control?.plan;
  }
  intentOrigin(intent: Intent) {
    return this.control?.origin(intent);
  }
  assertCurrentIntent(intent: Intent, tick: number) {
    this.control?.assertCurrentIntent(intent, tick);
  }
  acceptEffect(evidence: ExecutionEvidence) {
    this.control?.acceptEffect(evidence);
  }
}
