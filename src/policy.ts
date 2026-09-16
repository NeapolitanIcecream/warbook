import type { Intent, Observation } from "./model.js";
import { LegacyCommander } from "./legacy-policy.js";
import { ControlCoordinator } from "./control/coordinator.js";
import type {
  ControlComponents,
  ExecutionEvidence,
} from "./control/contracts.js";

export const POLICY_VERSION = "warbook-0.1.6";
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
    else {
      if (components)
        throw new Error("Layer replacement is supported for factory-exit only");
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
