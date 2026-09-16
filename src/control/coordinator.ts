import type { Intent, Observation } from "../model.js";
import { OpeningStrategy } from "./strategy.js";
import { LocalCombat } from "./tactics.js";
import { QueueProduction } from "./production.js";
import type {
  ControlComponents,
  ControlReport,
  ControlResult,
  ExecutionEvidence,
  IntentOrigin,
  StrategicPlan,
} from "./contracts.js";

/** One game-scoped owner of tasks and intent attribution. It has no game API. */
export class ControlCoordinator {
  readonly components: ControlComponents;
  private origins = new WeakMap<Intent, IntentOrigin>();
  private evidence: ExecutionEvidence[] = [];
  report?: ControlReport;
  plan?: StrategicPlan;
  constructor(components: Partial<ControlComponents> = {}) {
    this.components = {
      strategy: components.strategy ?? new OpeningStrategy(),
      tactics: components.tactics ?? new LocalCombat(),
      production: components.production ?? new QueueProduction(),
    };
  }
  acceptEffect(evidence: ExecutionEvidence): void {
    this.evidence.push(evidence);
  }
  origin(intent: Intent): IntentOrigin | undefined {
    return this.origins.get(intent);
  }
  assertCurrentIntent(intent: Intent, tick: number): void {
    const origin = this.origins.get(intent);
    if (!origin || this.plan?.tick !== tick)
      throw new Error("Intent is not from the current control decision");
    const task =
      origin.controller === "production"
        ? this.plan.production
        : this.plan.combat;
    if (origin.id !== task.id || origin.revision !== task.revision)
      throw new Error("Intent belongs to a superseded task");
  }

  decide(o: Observation): Intent[] {
    const { strategy, tactics, production } = this.components;
    const assessment = tactics.assess(o, strategy.assessmentRequest(o));
    const plan = strategy.plan(o, assessment, this.report);
    const evidence = this.evidence;
    this.evidence = [];
    const economy = production.control(
      o,
      plan.production,
      evidence.filter((e) => e.origin.controller === "production"),
    );
    const combat = tactics.control(
      o,
      plan.combat,
      evidence.filter((e) => e.origin.controller === "tactics"),
    );
    const intents = this.compile(o, plan, [economy, combat]);
    this.plan = plan;
    this.report = {
      tick: o.tick,
      components: {
        strategy: strategy.id,
        tactics: tactics.id,
        production: production.id,
      },
      combat: {
        ...combat.report,
        facts: {
          ...combat.report.facts,
          objective: plan.combat.objective,
          observedArmor: assessment.observedArmor,
          armorOutsideFactories: assessment.armorOutsideFactories,
        },
      },
      production: economy.report,
    };
    return intents;
  }

  /** Synchronous admission. A later asynchronous driver needs its own validated delay protocol. */
  compile(
    o: Observation,
    plan: StrategicPlan,
    results: readonly ControlResult[],
  ): Intent[] {
    if (plan.tick !== o.tick) throw new Error("Stale control plan");
    if (plan.combat.id === plan.production.id)
      throw new Error("Task IDs must be distinct");
    this.origins = new WeakMap();
    const owners = new Map<string, string>();
    const owned = new Set(o.own.map((u) => u.ref));
    for (const task of [
      { id: plan.production.id, refs: plan.production.deploymentUnits },
      { id: plan.combat.id, refs: plan.combat.units },
    ])
      for (const ref of task.refs) {
        if (!owned.has(ref) || owners.has(ref))
          throw new Error("Conflicting or unavailable task assignment");
        owners.set(ref, task.id);
      }
    const intents: Intent[] = [];
    const assigned = new Set<string>(),
      queues = new Set<number>();
    for (const result of results) {
      const task =
        result.origin.controller === "production"
          ? plan.production
          : plan.combat;
      if (
        result.origin.id !== task.id ||
        result.origin.revision !== task.revision ||
        result.report.task.id !== task.id ||
        result.report.task.revision !== task.revision
      )
        throw new Error("Stale task result");
      for (const intent of result.intents) {
        if (result.origin.controller === "tactics" && !("refs" in intent))
          throw new Error("Tactics cannot spend production resources");
        if ("refs" in intent)
          for (const ref of intent.refs) {
            if (owners.get(ref) !== task.id || assigned.has(ref))
              throw new Error("Intent violates task ownership");
            assigned.add(ref);
          }
        if (intent.kind === "queue") {
          if (queues.has(intent.product.queue))
            throw new Error("Conflicting production queue");
          queues.add(intent.product.queue);
        }
        this.origins.set(intent, result.origin);
        intents.push(intent);
      }
    }
    return intents;
  }
}
