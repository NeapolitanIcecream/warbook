import type { Intent, Observation } from "../model.js";
import {
  currentEvidence,
  type ControlResult,
  type ExecutionEvidence,
  type ProductionController,
  type ProductionPlan,
} from "./contracts.js";

/** Mechanical commitment accounting includes refinery-granted harvesters. */
export function committedStock(o: Observation, name: string): number {
  const grants = (product: string) =>
    o.catalogue?.find((p) => p.name === product)?.grants ??
    ({ GAREFN: "CMIN", NAREFN: "HARV" } as Record<string, string>)[product];
  return (
    o.own.filter((u) => u.name === name).length +
    o.queues.reduce(
      (n, q) =>
        n +
        q.items.reduce(
          (sum, item) =>
            sum +
            (item.name === name || grants(item.name) === name
              ? item.quantity
              : 0),
          0,
        ),
      0,
    ) +
    o.own.filter((u) => u.buildStatus === 0 && grants(u.name) === name).length
  );
}

/** Executes explicit orders. There are no power, army, scouting or repair priorities here. */
export class ProgramProduction implements ProductionController {
  readonly id = "program-production-v1";
  private lastDeploy = new Map<string, number>();
  control(
    o: Observation,
    plan: ProductionPlan,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult {
    if (!("program" in plan))
      throw new Error("ProgramProduction requires explicit orders");
    const { program } = plan;
    const intents: Intent[] = [];
    const blocked = { unavailable: 0, queueBusy: 0, cashFloor: 0 };
    const queues = new Set<number>();
    for (const order of program.queues) {
      if (queues.has(order.queue)) throw new Error("Duplicate queue program");
      queues.add(order.queue);
      const q = o.queues.find((q) => q.type === order.queue);
      if (!q) continue;
      if (order.mode === "cancel") {
        if (q.size)
          intents.push({
            kind: "queueControl",
            queue: q.type,
            action: "cancel",
          });
        continue;
      }
      // QueueStatus: Available=0, Producing=1, Paused=2, Ready=3.
      if (order.mode === "pause" || o.credits < order.reserve) {
        if (o.credits < order.reserve) blocked.cashFloor++;
        if (q.status === 1)
          intents.push({
            kind: "queueControl",
            queue: q.type,
            action: "pause",
          });
        continue;
      }
      if (q.status === 2) {
        intents.push({ kind: "queueControl", queue: q.type, action: "resume" });
        continue;
      }
      if (q.size || q.status !== 0) {
        blocked.queueBusy++;
        continue;
      }
      if (!order.product || order.target === 0) continue;
      if (order.target >= 0 && committedStock(o, order.product) >= order.target)
        continue;
      const product = o.products.find(
        (p) => p.name === order.product && p.queue === q.type,
      );
      if (!product) {
        blocked.unavailable++;
        continue;
      }
      intents.push({ kind: "queue", product });
    }
    for (const placement of program.placements) {
      if (
        o.queues.some(
          (q) => q.status === 3 && q.items[0]?.name === placement.name,
        ) &&
        (o.placementChoices ?? o.buildSites).some(
          (p) =>
            p.name === placement.name &&
            p.x === placement.x &&
            p.y === placement.y,
        )
      )
        intents.push({ kind: "place", ...placement });
    }
    const selling = new Set(program.sell);
    const repairing = new Set(program.repair);
    for (const unit of o.own) {
      if (selling.has(unit.ref) && unit.sellable) {
        intents.push({ kind: "sell", ref: unit.ref });
      } else if (
        unit.type === 2 &&
        unit.repairable &&
        (unit.hp < unit.maxHp || unit.hasWrenchRepair) &&
        !!unit.hasWrenchRepair !== repairing.has(unit.ref)
      ) {
        intents.push({
          kind: "repair",
          ref: unit.ref,
          enabled: repairing.has(unit.ref),
        });
      }
    }
    for (const ref of plan.deploymentUnits) {
      if (!o.own.some((u) => u.ref === ref && (u.mcv || u.yard))) continue;
      if (o.tick - (this.lastDeploy.get(ref) ?? -90) >= 90) {
        this.lastDeploy.set(ref, o.tick);
        intents.push({ kind: "deploy", refs: [ref] });
      }
    }
    const origin = {
      id: plan.id,
      revision: plan.revision,
      controller: "production" as const,
    };
    return {
      origin,
      intents,
      report: {
        task: { id: plan.id, revision: plan.revision },
        status: intents.length ? "active" : "waiting",
        reason: "explicit-program",
        proposedIntents: intents.length,
        facts: blocked,
        executionEvidence: currentEvidence(plan, evidence),
      },
    };
  }
}
