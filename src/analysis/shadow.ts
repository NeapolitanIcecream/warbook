import { isDeepStrictEqual } from "node:util";
import type { Intent, Observation } from "../model.js";

export class ShadowMismatch extends Error {
  constructor(
    readonly observation: Observation,
    readonly live: Intent[],
    readonly shadow: Intent[],
  ) {
    super(`Shadow decision differs at tick ${observation.tick}`);
  }
}

/** Decision-only comparison on the same legal input. The shadow never observes or submits. */
export class DecisionShadow {
  comparisons = 0;
  mismatches = 0;
  liveMillis = 0;
  shadowMillis = 0;
  lastComparedTick?: number;

  decide(
    observation: Observation,
    live: (o: Observation) => Intent[],
    shadow: (o: Observation) => Intent[],
  ): Intent[] {
    const shadowInput = structuredClone(observation);
    let liveResult!: Intent[], shadowResult!: Intent[];
    const runLive = () => {
      const t = performance.now();
      liveResult = live(observation);
      this.liveMillis += performance.now() - t;
    };
    const runShadow = () => {
      const t = performance.now();
      shadowResult = shadow(shadowInput);
      this.shadowMillis += performance.now() - t;
    };
    if (this.comparisons % 2) {
      runShadow();
      runLive();
    } else {
      runLive();
      runShadow();
    }
    this.comparisons++;
    this.lastComparedTick = observation.tick;
    if (!isDeepStrictEqual(liveResult, shadowResult)) {
      this.mismatches++;
      throw new ShadowMismatch(observation, liveResult, shadowResult);
    }
    return liveResult;
  }
  summary() {
    return {
      comparisons: this.comparisons,
      mismatches: this.mismatches,
      lastComparedTick: this.lastComparedTick,
      allComparedDecisionsMatched:
        this.comparisons > 0 && this.mismatches === 0,
      liveDecisionMillis: this.liveMillis,
      shadowDecisionMillis: this.shadowMillis,
      timingScope:
        "decision calls on identical observations, alternating call order; excludes observation, clone, submission and logging",
    };
  }
}
