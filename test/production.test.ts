import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueProduction } from "../src/control/production.js";
import type { ProductionPlan } from "../src/control/contracts.js";
import type { Observation, Unit } from "../src/model.js";

const unit = (name: string, ref: string, buildStatus?: number): Unit => ({
  name,
  ref,
  buildStatus,
  type: name.endsWith("REFN") ? 2 : 7,
  x: 40,
  y: 40,
  width: 1,
  height: 1,
  hp: 600,
  maxHp: 600,
  mobile: name === "CMIN" || name === "HARV",
  idle: true,
  harvester: name === "CMIN" || name === "HARV",
  mcv: false,
  yard: false,
  refinery: name.endsWith("REFN"),
  combat: false,
});
function fixture(soviet = false): { o: Observation; plan: ProductionPlan } {
  const refinery = soviet ? "NAREFN" : "GAREFN";
  const harvester = soviet ? "HARV" : "CMIN";
  const armor = soviet ? "HTNK" : "MTNK";
  const power = soviet ? "NAPOWR" : "GAPOWR";
  return {
    o: {
      tick: 6000,
      side: soviet ? 1 : 0,
      credits: 2000,
      power: { total: 200, drain: 100, isLowPower: false },
      home: { x: 40, y: 40 },
      starts: [],
      enemies: [],
      buildSites: [],
      own: [
        unit(power, "power", 1),
        unit(refinery, "first-refinery", 1),
        ...[1, 2, 3].map((n) => unit(harvester, `miner-${n}`)),
      ],
      products: [
        { name: refinery, cost: 2000, type: 2, queue: 0 },
        { name: harvester, cost: 1400, type: 7, queue: 3 },
        { name: armor, cost: soviet ? 900 : 700, type: 7, queue: 3 },
      ],
      queues: [0, 2, 3].map((type) => ({
        type,
        size: 0,
        status: 0,
        items: [],
      })),
    },
    plan: {
      id: "production",
      revision: 1,
      deploymentUnits: [],
      power: { product: power, margin: 30 },
      structures: [{ product: refinery, count: 2 }],
      vehicles: {
        armor,
        harvester,
        harvesters: 4,
        antiAir: soviet ? "HTK" : "FV",
        mobileAntiAir: 0,
      },
      infantry: { product: "E1", count: 0 },
      spending: { queueStartFloor: 250, infantryAbove: 800 },
    },
  };
}
const vehicleOrder = (result: ReturnType<QueueProduction["control"]>) =>
  result.intents.find((i) => i.kind === "queue" && i.product.queue === 3);

test("one surviving scout does not prevent building or replacing a second scout", () => {
  const { o, plan } = fixture();
  const controller = new QueueProduction();
  plan.scouts = { product: "ADOG", count: 2 };
  plan.infantry = { product: "E1", count: 6 };
  o.products.push({ name: "ADOG", cost: 200, type: 3, queue: 2 });
  o.own.push(unit("E1", "gi-1"), unit("E1", "gi-2"), unit("ADOG", "dog-1"));
  const requestsDog = () =>
    controller
      .control(o, plan, [])
      .intents.some((i) => i.kind === "queue" && i.product.name === "ADOG");
  assert(requestsDog());
  o.tick += 200;
  o.own.push(unit("ADOG", "dog-2"));
  assert(!requestsDog());
  o.tick += 3;
  o.own = o.own.filter((u) => u.ref !== "dog-2");
  assert(
    !requestsDog(),
    "brief unavailability is debounced even with a surviving dog",
  );
  o.tick += 150;
  assert(requestsDog());
});

test("refinery commitment survives queue, ready placement and buildup, then becomes one live miner", () => {
  for (const soviet of [false, true]) {
    const { o, plan } = fixture(soviet);
    const controller = new QueueProduction();
    const refinery = plan.structures[0].product;
    const armor = plan.vehicles.armor;
    const check = () => {
      const result = controller.control(o, plan, []);
      const order = vehicleOrder(result);
      assert.equal(order?.kind === "queue" && order.product.name, armor);
      assert.equal(result.report.facts.committedHarvesters, 4);
    };
    check(); // Newly proposed, accepted refinery queue shares this decision.
    for (const status of [1, 2, 3]) {
      o.tick += 3;
      o.queues[0] = {
        type: 0,
        size: 1,
        status,
        items: [{ name: refinery, quantity: 1 }],
      };
      if (status === 3) o.buildSites = [{ name: refinery, x: 42, y: 45 }];
      check(); // Placement intent must not count the same ready refinery again.
    }
    o.queues[0] = { type: 0, size: 0, status: 0, items: [] };
    o.buildSites = [];
    o.own.push(unit(refinery, "second-refinery", 0));
    check();
    o.own.at(-1)!.buildStatus = 1;
    o.own.push(unit(plan.vehicles.harvester, "free-miner"));
    check();
  }
});

test("cancelled or destroyed refinery commitments do not permanently suppress miner replacement", () => {
  for (const destroyed of [false, true]) {
    const { o, plan } = fixture();
    const controller = new QueueProduction();
    const refinery = plan.structures[0].product;
    if (destroyed) o.own.push(unit(refinery, "doomed", 0));
    else
      o.queues[0] = {
        type: 0,
        size: 1,
        status: 1,
        items: [{ name: refinery, quantity: 1 }],
      };
    assert.equal(
      controller.control(o, plan, []).report.facts.committedHarvesters,
      4,
    );
    o.own = o.own.filter((u) => u.ref !== "doomed");
    o.queues[0] = { type: 0, size: 0, status: 0, items: [] };
    const revised = { ...plan, revision: 2, structures: [] };
    const result = controller.control(o, revised, []);
    const order = vehicleOrder(result);
    assert.equal(order?.kind === "queue" && order.product.name, "CMIN");
    assert.equal(result.report.facts.committedHarvesters, 3);
  }
});

test("completed refinery without a spawned miner releases the expected free unit", () => {
  const { o, plan } = fixture();
  o.own.push(unit("GAREFN", "second-refinery", 1));
  const result = new QueueProduction().control(o, plan, []);
  const order = vehicleOrder(result);
  assert.equal(order?.kind === "queue" && order.product.name, "CMIN");
  assert.equal(result.report.facts.refineryHarvesters, 0);
});

test("a future refinery goal cannot reserve a miner when its queue request is unavailable or blocked", () => {
  for (const unavailable of [false, true]) {
    const { o, plan } = fixture();
    if (unavailable) o.products = o.products.filter((p) => p.name !== "GAREFN");
    else
      o.queues[0] = {
        type: 0,
        status: 1,
        size: 1,
        items: [{ name: "GAWEAP", quantity: 1 }],
      };
    const result = new QueueProduction().control(o, plan, []);
    const order = vehicleOrder(result);
    assert.equal(order?.kind === "queue" && order.product.name, "CMIN");
    assert.equal(result.report.facts.refineryHarvesters, 0);
  }
});

test("an active miner queue is counted and kept; cancelling it allows a replacement", () => {
  const { o, plan } = fixture();
  const controller = new QueueProduction();
  const noExpansion = { ...plan, structures: [] };
  o.queues[2] = {
    type: 3,
    size: 1,
    status: 1,
    items: [{ name: "CMIN", quantity: 1 }],
  };
  const result = controller.control(o, noExpansion, []);
  assert.equal(result.report.facts.committedHarvesters, 4);
  assert.equal(vehicleOrder(result), undefined);
  o.queues[2] = { type: 3, size: 0, status: 0, items: [] };
  const order = vehicleOrder(controller.control(o, noExpansion, []));
  assert.equal(order?.kind === "queue" && order.product.name, "CMIN");
});
