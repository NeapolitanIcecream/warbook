import type { Intent, Observation } from "../model.js";
import {
  currentEvidence,
  type ControlResult,
  type ExecutionEvidence,
  type ProductionController,
  type ProductionPlan,
} from "./contracts.js";

// Pinned 0.83.3 rules: each of these refineries grants one harvester when its
// placed building changes from BuildUp (0) to Ready (1). Recompute from current
// observations so cancellation, destruction, or a failed spawn releases it.
const harvesterRefineries = new Set(["GAREFN", "NAREFN"]);

/** Executes inventory goals and credit gates. It does not choose economic expansion policy. */
export class QueueProduction implements ProductionController {
  readonly id = "queue-production-v2";
  private lastDeploy = new Map<string, number>();
  private lastScoutsSatisfied = -Infinity;
  private lastScoutRequested = -Infinity;
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
    for (const defense of plan.defenses ?? [])
      if (count(defense.product) < defense.count) queue(defense.product);
    const v = plan.vehicles;
    const liveHarvesters = o.own.filter((u) => u.harvester).length;
    const queuedHarvesters = o.queues.reduce(
      (sum, q) =>
        sum +
        q.items.reduce(
          (n, item) => n + (item.name === v.harvester ? item.quantity : 0),
          0,
        ),
      0,
    );
    const refineryHarvesters =
      o.queues.reduce(
        (sum, q) =>
          sum +
          q.items.reduce(
            (n, item) =>
              n + (harvesterRefineries.has(item.name) ? item.quantity : 0),
            0,
          ),
        0,
      ) +
      o.own.filter(
        (u) => harvesterRefineries.has(u.name) && u.buildStatus === 0,
      ).length +
      intents.filter(
        (i) => i.kind === "queue" && harvesterRefineries.has(i.product.name),
      ).length;
    const committedHarvesters =
      liveHarvesters + queuedHarvesters + refineryHarvesters;
    queue(
      o.own.filter((u) => u.antiAir && u.mobile).length < v.mobileAntiAir
        ? v.antiAir
        : committedHarvesters < v.harvesters
          ? v.harvester
          : v.armor,
    );
    const infantry = o.own.filter((u) =>
      plan.scouts ? u.name === plan.infantry.product : u.type === 3 && u.combat,
    ).length;
    if (plan.scouts && count(plan.scouts.product) >= plan.scouts.count)
      this.lastScoutsSatisfied = o.tick;
    if (
      plan.scouts &&
      infantry >= 2 &&
      count(plan.scouts.product) < plan.scouts.count &&
      o.tick - Math.max(this.lastScoutsSatisfied, this.lastScoutRequested) >=
        150 &&
      o.credits > plan.spending.infantryAbove
    ) {
      queue(plan.scouts.product);
      if (
        intents.some(
          (i) => i.kind === "queue" && i.product.name === plan.scouts!.product,
        )
      )
        this.lastScoutRequested = o.tick;
    }
    if (
      infantry < plan.infantry.count &&
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
        facts: {
          credits: o.credits,
          liveHarvesters,
          queuedHarvesters,
          refineryHarvesters,
          committedHarvesters,
          ...blocked,
        },
        executionEvidence: currentEvidence(plan, evidence),
      },
    };
  }
}
