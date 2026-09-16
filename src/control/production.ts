import type { Intent, Observation } from "../model.js";
import {
  currentEvidence,
  type ControlResult,
  type ExecutionEvidence,
  type ProductionController,
  type ProductionPlan,
} from "./contracts.js";

/** Executes inventory goals and credit gates. It does not choose economic expansion policy. */
export class QueueProduction implements ProductionController {
  readonly id = "queue-production-v1";
  private lastDeploy = new Map<string, number>();
  control(
    o: Observation,
    plan: ProductionPlan,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult {
    const intents: Intent[] = [];
    const count = (name: string) => o.own.filter((u) => u.name === name).length;
    const blocked: Record<string, number> = {
      unavailable: 0,
      queueBusy: 0,
      insufficientFunds: 0,
    };
    for (const ref of plan.deploymentUnits) {
      if (o.tick - (this.lastDeploy.get(ref) ?? -90) >= 90) {
        intents.push({ kind: "deploy", refs: [ref] });
        this.lastDeploy.set(ref, o.tick);
      }
    }
    for (const site of o.buildSites) intents.push({ kind: "place", ...site });
    const queue = (name: string | undefined) => {
      if (!name) return;
      const product = o.products.find((p) => p.name === name);
      if (!product) {
        blocked.unavailable++;
        return;
      }
      const q = o.queues.find((q) => q.type === product.queue);
      if (!q || q.size || q.status !== 0) {
        blocked.queueBusy++;
        return;
      }
      if (o.credits < Math.min(product.cost, plan.spending.queueStartFloor)) {
        blocked.insufficientFunds++;
        return;
      }
      if (
        !intents.some(
          (i) => i.kind === "queue" && i.product.queue === product.queue,
        )
      )
        intents.push({ kind: "queue", product });
    };
    const power = plan.power.product;
    const building =
      o.power.isLowPower ||
      (count(power) && o.power.total - o.power.drain < plan.power.margin) ||
      !count(power)
        ? power
        : plan.structures.find((g) => count(g.product) < g.count)?.product;
    queue(building);
    const v = plan.vehicles;
    queue(
      o.own.filter((u) => u.antiAir && u.mobile).length < v.mobileAntiAir
        ? v.antiAir
        : o.own.filter((u) => u.harvester).length < v.harvesters
          ? v.harvester
          : v.armor,
    );
    if (
      o.own.filter((u) => u.type === 3 && u.combat).length <
        plan.infantry.count &&
      o.credits > plan.spending.infantryAbove
    )
      queue(plan.infantry.product);
    const isBlocked = Object.values(blocked).some(Boolean);
    return {
      origin: {
        id: plan.id,
        revision: plan.revision,
        controller: "production",
      },
      intents,
      report: {
        task: { id: plan.id, revision: plan.revision },
        status: intents.length ? "active" : isBlocked ? "blocked" : "idle",
        reason: intents.length
          ? "requests-proposed"
          : isBlocked
            ? "production-gates"
            : "no-request",
        proposedIntents: intents.length,
        facts: { credits: o.credits, ...blocked },
        executionEvidence: currentEvidence(plan, evidence),
      },
    };
  }
}
