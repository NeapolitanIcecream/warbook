import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProgramProduction,
  committedStock,
} from "../src/control/program-production.js";
import { queueRequestQuantity, type Observation } from "../src/model.js";
import type {
  ProgramProductionPlan,
  ExecutionEvidence,
} from "../src/control/contracts.js";

function observation(): Observation {
  const products = [
    { name: "GAPOWR", queue: 0, type: 2, cost: 800 },
    { name: "GAREFN", queue: 0, type: 2, cost: 2000, grants: "CMIN" },
    { name: "E1", queue: 2, type: 3, cost: 200 },
    { name: "CMIN", queue: 3, type: 7, cost: 1400 },
  ];
  return {
    tick: 0,
    side: 0,
    credits: 10000,
    power: { total: 200, drain: 0, isLowPower: false },
    home: { x: 20, y: 20 },
    starts: [],
    own: [],
    enemies: [],
    products,
    catalogue: products,
    buildSites: [],
    queues: Array.from({ length: 6 }, (_, type) => ({
      type,
      status: 0,
      size: 0,
      maxSize: type < 2 ? 1 : 30,
      items: [],
    })),
  };
}
function plan(
  product = "E1",
  target = 4,
  reserve = 0,
  queue = 2,
): ProgramProductionPlan {
  return {
    id: "production",
    revision: 1,
    deploymentUnits: [],
    program: {
      queues: [{ queue, mode: "run", product, target, reserve }],
      placements: [],
      repair: [],
      sell: [],
    },
  };
}
const run = (
  p: ProgramProduction,
  o: Observation,
  order = plan(),
  evidence: ExecutionEvidence[] = [],
) => p.control(o, order, evidence).intents;
function queued(
  o: Observation,
  queue: number,
  name: string,
  quantity: number,
  status = 1,
) {
  o.queues[queue] = {
    ...o.queues[queue],
    size: quantity,
    status,
    items: quantity ? [{ name, quantity }] : [],
  };
}

test("finite batches are optional and quantity one retains the legacy intent shape", () => {
  const o = observation();
  assert.deepEqual(run(new ProgramProduction(), o), [
    { kind: "queue", product: o.products[2] },
  ]);
  assert.deepEqual(run(new ProgramProduction(true), o), [
    { kind: "queue", product: o.products[2], quantity: 4 },
  ]);
  assert.deepEqual(
    run(new ProgramProduction(true), o, plan("E1", 1)),
    run(new ProgramProduction(), o, plan("E1", 1)),
  );
  assert.equal(new ProgramProduction().executionMode, "single-item-v1");
  assert.equal(
    new ProgramProduction(true).id,
    "program-production-native-batches-v1",
  );
});

test("capacity is total native quantity and buildings retain capacity one", () => {
  const o = observation();
  queued(o, 2, "ENGINEER", 28);
  assert.deepEqual(run(new ProgramProduction(true), o), [
    { kind: "queue", product: o.products[2], quantity: 2 },
  ]);
  queued(o, 2, "ENGINEER", 30);
  assert.deepEqual(run(new ProgramProduction(true), o), []);
  o.queues[2].maxSize = 20;
  assert.deepEqual(
    run(new ProgramProduction(true), o),
    [],
    "capacity shrink admits no new additions",
  );
  assert.deepEqual(
    run(new ProgramProduction(true), o, plan("GAPOWR", 2, 0, 0)),
    [{ kind: "queue", product: o.products[0] }],
  );
  queued(o, 0, "GAPOWR", 1, 3);
  assert.deepEqual(
    run(new ProgramProduction(true), o, plan("GAPOWR", 2, 0, 0)),
    [],
  );
});

test("pending batches suppress repeats, not acknowledged by existing same-product presence", () => {
  const p = new ProgramProduction(true),
    o = observation();
  queued(o, 2, "E1", 1);
  const order = plan("E1", 5);
  assert.equal((run(p, o, order)[0] as any).quantity, 4);
  assert.deepEqual(run(p, o, order), []);
  const evidence: ExecutionEvidence[] = [
    {
      origin: { id: "production", revision: 1, controller: "production" },
      intentId: "i",
      basedOnTick: 0,
      observedTick: 0,
      effect: "queue_item_observed",
      unresolved: false,
    },
  ];
  assert.deepEqual(run(p, o, order, evidence), []);
  o.tick = 3;
  queued(o, 2, "E1", 3);
  assert.deepEqual(run(p, o, order), [
    { kind: "queue", product: o.products[2], quantity: 2 },
  ]);
  o.tick = 6;
  queued(o, 2, "E1", 5);
  assert.deepEqual(run(p, o, order), []);
});

test("same-frame refinery grants and unsettled requests reserve stock without changing observations", () => {
  const p = new ProgramProduction(true),
    o = observation(),
    order = plan("CMIN", 1, 0, 3);
  order.program.queues = [
    ...order.program.queues,
    {
      queue: 0,
      product: "GAREFN",
      target: 1,
      reserve: 0,
      mode: "run",
    },
  ];
  const before = structuredClone(o);
  assert.deepEqual(run(p, o, order), [
    { kind: "queue", product: o.products[1] },
  ]);
  assert.deepEqual(o, before);
  assert.deepEqual(run(p, o, order), []);
  o.tick = 3;
  queued(o, 0, "GAREFN", 1);
  assert.equal(committedStock(o, "CMIN"), 1);
  assert.deepEqual(run(p, o, order), []);
});

test("CLEAR preserves the submitted batch and stops remaining demand", () => {
  const p = new ProgramProduction(true),
    o = observation();
  run(p, o);
  assert.deepEqual(run(p, o, plan("E1", 0)), []);
  assert.deepEqual(
    run(p, o, plan("E1", 8)),
    [],
    "CLEAR cannot erase pending bookkeeping",
  );
  o.tick = 3;
  queued(o, 2, "E1", 4);
  assert.deepEqual(run(p, o, plan("E1", 0)), []);
  assert.equal(o.queues[2].size, 4);
});

test("CANCEL while a batch is invisible drains its later tail before a replacement SET", () => {
  const p = new ProgramProduction(true),
    o = observation(),
    cancel = plan();
  cancel.program.queues[0].mode = "cancel";
  run(p, o);
  assert.deepEqual(run(p, o, cancel), []);
  assert.deepEqual(run(p, o, plan("E1", 0)), []);
  o.tick = 3;
  queued(o, 2, "E1", 4);
  assert.deepEqual(run(p, o), [
    { kind: "queueControl", queue: 2, action: "cancel" },
  ]);
  assert.deepEqual(run(p, o), []);
  o.tick = 6;
  queued(o, 2, "E1", 0, 0);
  assert.deepEqual(run(p, o), [
    { kind: "queue", product: o.products[2], quantity: 4 },
  ]);
});

test("a fully rejected request settles at the next offline observation without locking CANCEL", () => {
  const p = new ProgramProduction(true),
    o = observation(),
    cancel = plan();
  cancel.program.queues[0].mode = "cancel";
  run(p, o);
  assert.deepEqual(run(p, o, cancel), []);
  // A later observation follows awaited native processing, even if Add accepted zero.
  o.tick = 3;
  assert.deepEqual(run(p, o), [
    { kind: "queue", product: o.products[2], quantity: 4 },
  ]);
});

test("cash floors preserve pause/resume and CLEAR removes the floor", () => {
  const p = new ProgramProduction(true),
    o = observation(),
    order = plan("E1", 4, 500);
  o.credits = 400;
  assert.deepEqual(run(p, o, order), []);
  queued(o, 2, "E1", 4);
  assert.deepEqual(run(p, o, order), [
    { kind: "queueControl", queue: 2, action: "pause" },
  ]);
  queued(o, 2, "E1", 4, 2);
  assert.deepEqual(run(p, o, order), []);
  assert.deepEqual(run(p, o, plan("E1", 0)), [
    { kind: "queueControl", queue: 2, action: "resume" },
  ]);
  o.credits = 600;
  assert.deepEqual(run(p, o, order), [
    { kind: "queueControl", queue: 2, action: "resume" },
  ]);
});

test("unlimited targets keep original one-at-a-time empty-queue execution", () => {
  const o = observation(),
    a = new ProgramProduction(),
    b = new ProgramProduction(true),
    unlimited = plan("E1", -1);
  assert.deepEqual(run(a, o, unlimited), run(b, o, unlimited));
  o.tick = 3;
  assert.deepEqual(run(a, o, unlimited), run(b, o, unlimited));
  queued(o, 2, "E1", 1);
  assert.deepEqual(run(a, o, unlimited), run(b, o, unlimited));
});

test("bridge quantity validation rejects malformed or over-capacity requests", () => {
  const intent = { kind: "queue" as const, product: observation().products[2] };
  assert.equal(queueRequestQuantity(intent, { size: 0, maxSize: 30 }), 1);
  assert.equal(
    queueRequestQuantity({ ...intent, quantity: 4 }, { size: 26, maxSize: 30 }),
    4,
  );
  for (const quantity of [0, -1, 1.5, NaN, Infinity, 65536, 5])
    assert.throws(
      () =>
        queueRequestQuantity(
          { ...intent, quantity },
          { size: 26, maxSize: 30 },
        ),
      /quantity|capacity/,
    );
  assert.equal(
    queueRequestQuantity(intent, { size: 30, maxSize: 30 }),
    1,
    "single-item requests retain native clamping/ignore semantics",
  );
  assert.throws(
    () => queueRequestQuantity({ ...intent, quantity: 2 }, { size: 0 }),
    /capacity/,
  );
});
