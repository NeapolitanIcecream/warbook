import {
  nativeQueueFreeCapacity,
  type Intent,
  type Observation,
} from "../model.js";
import {
  currentEvidence,
  type ControlResult,
  type ExecutionEvidence,
  type ProductionController,
  type ProductionPlan,
} from "./contracts.js";

/** Mechanical commitment accounting includes refinery-granted harvesters. */
function grantedProduct(o: Observation, product: string): string | undefined {
  return (
    o.catalogue?.find((p) => p.name === product)?.grants ??
    ({ GAREFN: "CMIN", NAREFN: "HARV" } as Record<string, string>)[product]
  );
}
export function committedStock(o: Observation, name: string): number {
  const grants = (product: string) => grantedProduct(o, product);
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
  constructor(readonly nativeFiniteBatches = false) {}
  get id() {
    return this.nativeFiniteBatches
      ? "program-production-native-batches-v1"
      : "program-production-v1";
  }
  get executionMode() {
    return this.nativeFiniteBatches
      ? ("native-finite-batches-v1" as const)
      : ("single-item-v1" as const);
  }
  private lastDeploy = new Map<string, number>();
  private pending = new Map<
    number,
    {
      tick: number;
      product: string;
      quantity: number;
    }
  >();
  private cancellations = new Map<number, { sentTick?: number }>();
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
    const reserved = new Map<string, number>();
    const reserve = (name: string, quantity: number) => {
      reserved.set(name, (reserved.get(name) ?? 0) + quantity);
      const granted = grantedProduct(o, name);
      if (granted)
        reserved.set(granted, (reserved.get(granted) ?? 0) + quantity);
    };
    if (this.nativeFiniteBatches) {
      for (const [queue, pending] of this.pending) {
        // Pinned offline AiPlayTurnManager processes queued actions before
        // game.update; runner awaits updates before its next observation.
        // Tick advancement settles Add even when it accepted zero. Recompute
        // from real stock; a submission is never fabricated into observations.
        if (o.tick > pending.tick) this.pending.delete(queue);
      }
    }
    const cancelling = new Set<number>();
    if (this.nativeFiniteBatches) {
      for (const order of program.queues)
        if (
          order.mode === "cancel" &&
          (this.pending.has(order.queue) ||
            o.queues.some((q) => q.type === order.queue && q.size > 0))
        )
          if (!this.cancellations.has(order.queue))
            this.cancellations.set(order.queue, {});
      for (const [queue, cancellation] of this.cancellations) {
        const q = o.queues.find((q) => q.type === queue);
        if (q && q.size > 0) {
          if (cancellation.sentTick !== o.tick) {
            intents.push({ kind: "queueControl", queue, action: "cancel" });
            cancellation.sentTick = o.tick;
          }
        } else if (
          (cancellation.sentTick !== undefined &&
            o.tick > cancellation.sentTick) ||
          !this.pending.has(queue)
        ) {
          // Ordered native cancellation has drained the queue, including any
          // earlier submitted batch. A later SET may now request a new order.
          this.pending.delete(queue);
          this.cancellations.delete(queue);
          continue;
        }
        cancelling.add(queue);
      }
      for (const pending of this.pending.values())
        reserve(pending.product, pending.quantity);
    }
    // Resolve same-frame grant dependencies, even if queue plans were reordered.
    // This only changes accounting order, not production targets or cash policy.
    const orders: (typeof program.queues)[number][] = [];
    const visiting = new Set<number>();
    const visit = (order: (typeof program.queues)[number]) => {
      if (orders.includes(order)) return;
      if (visiting.has(order.queue))
        throw new Error("Cyclic production grant dependency");
      visiting.add(order.queue);
      for (const source of program.queues)
        if (
          source !== order &&
          source.product &&
          order.product &&
          grantedProduct(o, source.product) === order.product
        )
          visit(source);
      visiting.delete(order.queue);
      orders.push(order);
    };
    if (this.nativeFiniteBatches) program.queues.forEach(visit);
    else orders.push(...program.queues);
    for (const order of orders) {
      if (queues.has(order.queue)) throw new Error("Duplicate queue program");
      queues.add(order.queue);
      const q = o.queues.find((q) => q.type === order.queue);
      if (!q) continue;
      if (cancelling.has(order.queue)) continue;
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
      const finiteBatch = this.nativeFiniteBatches && order.target > 0;
      if (!finiteBatch && (q.size || q.status !== 0)) {
        blocked.queueBusy++;
        continue;
      }
      if (!order.product || order.target === 0) continue;
      const deficit =
        order.target -
        committedStock(o, order.product) -
        (this.nativeFiniteBatches ? (reserved.get(order.product) ?? 0) : 0);
      if (order.target >= 0 && deficit <= 0) continue;
      const product = o.products.find(
        (p) => p.name === order.product && p.queue === q.type,
      );
      if (!product) {
        blocked.unavailable++;
        continue;
      }
      let quantity = 1;
      if (finiteBatch) {
        if (!Number.isSafeInteger(order.target))
          throw new Error("Invalid finite production target");
        if (this.pending.has(q.type)) {
          blocked.queueBusy++;
          continue;
        }
        const capacity = nativeQueueFreeCapacity(q);
        if (
          !capacity ||
          (q.status !== 0 &&
            q.status !== 1 &&
            !(q.status === 3 && product.type !== 2))
        ) {
          blocked.queueBusy++;
          continue;
        }
        quantity = Math.min(deficit, capacity, 65535);
      } else if (this.nativeFiniteBatches && this.pending.has(q.type)) {
        blocked.queueBusy++;
        continue;
      }
      intents.push({
        kind: "queue",
        product,
        ...(quantity === 1 ? {} : { quantity }),
      });
      if (this.nativeFiniteBatches) {
        reserve(product.name, quantity);
        if (finiteBatch)
          this.pending.set(q.type, {
            tick: o.tick,
            product: product.name,
            quantity,
          });
      }
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
