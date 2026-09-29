import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  NeuralCommanderPolicy,
  prepareCommander,
  type CommanderModel,
} from "../src/commander/network.js";
import { FullCommander } from "../src/commander/controller.js";
import { resolveProductionTemperatures } from "../src/commander/action-mask.js";
import {
  buildWorld,
  ContactMemory,
  initialProgram,
  keepAction,
} from "../src/commander/world.js";
import type { Observation, Unit } from "../src/model.js";

before(prepareCommander);

function artifact(): CommanderModel {
  const tensors: CommanderModel["tensors"] = {};
  const tensor = (name: string, shape: number[]) => {
    const seed = [...name].reduce((n, c) => n + c.charCodeAt(0), 0);
    tensors[name] = {
      shape,
      values: Array.from(
        { length: shape.reduce((n, d) => n * d, 1) },
        (_, i) => (((i * 13 + seed * 7) % 43) - 21) / 2000,
      ),
    };
  };
  for (const [name, output, input] of [
    ["entity0", 64, 80],
    ["entity1", 64, 128],
    ["region0", 32, 16],
    ["region1", 32, 64],
    ["product0", 64, 40],
    ["product1", 64, 128],
    ["goal0", 64, 112],
    ["place0", 64, 32],
    ["task0", 32, 32],
    ["world0", 128, 608],
    ["queue0", 64, 224],
    ["queueSpecial", 4, 64],
    ["queueParameter", 11, 128],
    ["queueContext", 64, 144],
    ["taskQuery", 64, 240],
    ["kind", 11, 64],
    ["goalQuery", 64, 80],
    ["engagement", 8, 64],
    ["roleKeys", 64, 144],
    ["unitQuery", 64, 192],
    ["building0", 64, 192],
    ["building1", 4, 64],
    ["placeQuery", 64, 160],
    ["placeKeep", 1, 64],
    ["value0", 64, 128],
    ["value1", 1, 64],
  ] as const) {
    tensor(name + ".weight", [output, input]);
    tensor(name + ".bias", [output]);
  }
  for (const name of ["weight_ih", "weight_hh"])
    tensor("memory." + name, [384, 128]);
  for (const name of ["bias_ih", "bias_hh"]) tensor("memory." + name, [384]);
  tensor("names.weight", [4, 16]);
  tensor("slots.weight", [16, 16]);
  tensor("kindEmbedding.weight", [11, 16]);
  tensor("queueSpecialKeys", [4, 64]);
  tensor("roleSpecialKeys", [4, 64]);
  tensors["queueParameter.bias"].values = Array.from(
    { length: 11 },
    (_, i) => i / 10,
  );
  return {
    format: "warbook-commander-model-v1",
    schema: "commander-v1",
    encoding: "graph-plan-v2",
    hidden: 128,
    temperature: 0.01,
    vocabulary: ["GACNST", "GAPOWR", "MTNK"],
    tensors,
  };
}

function observation(): Observation {
  const unit: Unit = {
    ref: "tank",
    name: "MTNK",
    type: 7,
    x: 20,
    y: 20,
    hp: 300,
    maxHp: 300,
    width: 1,
    height: 1,
    mobile: true,
    idle: true,
    harvester: false,
    mcv: false,
    yard: false,
    refinery: false,
    combat: true,
  };
  return {
    tick: 0,
    side: 0,
    credits: 10000,
    power: { total: 200, drain: 100, isLowPower: false },
    home: { x: 20, y: 20 },
    starts: [
      { x: 20, y: 20 },
      { x: 80, y: 80 },
    ],
    own: [
      unit,
      {
        ...unit,
        ref: "yard",
        name: "GACNST",
        type: 2,
        yard: true,
        mobile: false,
        sellable: true,
        repairable: true,
      },
    ],
    enemies: [],
    products: [
      { name: "GAPOWR", type: 2, queue: 0, cost: 800 },
      { name: "MTNK", type: 7, queue: 3, cost: 700 },
    ],
    queues: Array.from({ length: 6 }, (_, type) => ({
      type,
      status: type === 0 ? 3 : 0,
      size: type === 0 ? 1 : 0,
      items: type === 0 ? [{ name: "GAPOWR", quantity: 1 }] : [],
    })),
    buildSites: [{ name: "GAPOWR", x: 23, y: 20 }],
  };
}

test("v4 overrides are optional, finite, positive and forbidden in older encodings", () => {
  assert.deepEqual(resolveProductionTemperatures("graph-plan-v4", 0.01), {
    queue: 0.01,
    amount: 0.01,
    cash: 0.01,
  });
  assert.deepEqual(
    resolveProductionTemperatures("graph-plan-v4", 0.01, { amount: 2 }),
    { queue: 0.01, amount: 2, cash: 0.01 },
  );
  for (const value of [0, -1, NaN, Infinity, true, "2", null])
    assert.throws(
      () =>
        resolveProductionTemperatures("graph-plan-v4", 0.01, {
          amount: value,
        } as any),
      /Invalid production/,
    );
  for (const value of [null, [], { unknown: 1 }])
    assert.throws(
      () => resolveProductionTemperatures("graph-plan-v4", 0.01, value as any),
      /Invalid production/,
    );
  assert.throws(
    () =>
      new NeuralCommanderPolicy({ ...artifact(), productionTemperatures: {} }),
    /require graph-plan-v4/,
  );
});

test("v4 with no overrides has exactly the v2 probabilities, hidden state and greedy action", () => {
  const source = artifact(),
    world = buildWorld(observation(), initialProgram(), new ContactMemory());
  const a = new NeuralCommanderPolicy(source, true),
    b = new NeuralCommanderPolicy(
      { ...source, encoding: "graph-plan-v4" },
      true,
    );
  try {
    assert.deepEqual(
      a.predict(world, Array(128).fill(0), () => 0.5, true),
      b.predict(world, Array(128).fill(0), () => 0.5, true),
    );
  } finally {
    a.dispose();
    b.dispose();
  }
});

test("each production temperature changes only its factor probabilities with the action context fixed", () => {
  const source = { ...artifact(), encoding: "graph-plan-v4" as const },
    world = buildWorld(observation(), initialProgram(), new ContactMemory());
  const action = keepAction(world);
  action.queues[0] = 4;
  action.queues[3] = 5;
  action.kinds[0] = 4;
  action.goals[0] = 1;
  action.units[0] = 0;
  const control = new NeuralCommanderPolicy(source, true);
  try {
    const reference = control.predict(
      world,
      Array(128).fill(0),
      () => 0.5,
      true,
      action,
    );
    for (const family of ["queue", "amount", "cash"] as const) {
      const candidate = new NeuralCommanderPolicy(
        { ...source, productionTemperatures: { [family]: 2 } },
        true,
      );
      try {
        const actual = candidate.predict(
          world,
          Array(128).fill(0),
          () => 0.5,
          true,
          action,
        );
        assert.deepEqual(actual.hidden, reference.hidden);
        assert.equal(actual.value, reference.value);
        assert.notDeepEqual(
          actual.probabilities![family + "0"],
          reference.probabilities![family + "0"],
        );
        for (const key of Object.keys(reference.probabilities!))
          if (!key.startsWith(family))
            assert.deepEqual(
              actual.probabilities![key],
              reference.probabilities![key],
              key,
            );
      } finally {
        candidate.dispose();
      }
    }
  } finally {
    control.dispose();
  }
});

test("v4 decision records contain every effective production temperature", () => {
  const commander = new FullCommander("bastion", {
    hiddenSize: 128,
    encoding: "graph-plan-v4",
    temperature: 0.01,
    productionTemperatures: { cash: 3 },
    memberScoring: { mode: "current-task-keep-v1" },
    predict(world, hidden) {
      return {
        action: keepAction(world),
        hidden: [...hidden],
        logp: 0,
        value: 0,
        entropy: 0,
      };
    },
  });
  commander.plan(observation(), {
    army: [],
    observedArmor: 0,
    armorOutsideFactories: 0,
  });
  assert.deepEqual(commander.record?.productionTemperatures, {
    queue: 0.01,
    amount: 0.01,
    cash: 3,
  });
  assert.equal(commander.record?.temperature, 0.01);
  assert.deepEqual(commander.record?.memberScoring, {
    mode: "current-task-keep-v1",
  });
  assert.equal(commander.record?.action.edits, undefined);
});
