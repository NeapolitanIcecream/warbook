import assert from "node:assert/strict";
import { before, test } from "node:test";
import {
  NeuralCommanderPolicy,
  prepareCommander,
  type CommanderModel,
} from "../src/commander/network.js";
import {
  commanderRoleMask,
  commanderArtifactEncoding,
  memberKeepEligible,
  resolveMemberScoring,
  type CommanderEncoding,
  type MemberScoring,
} from "../src/commander/action-mask.js";
import {
  buildWorld,
  ContactMemory,
  initialProgram,
  keepAction,
  KEEP_UNIT,
  RESERVE,
  DEPLOY,
  type CommanderWorld,
} from "../src/commander/world.js";
import type { CommanderPrediction } from "../src/commander/controller.js";
import type { Observation, Unit } from "../src/model.js";

before(prepareCommander);
const MODES: MemberScoring[] = [
  { mode: "separate-v1" },
  { mode: "current-task-keep-v1" },
  { mode: "keep-bias-v1", bias: Math.log(2) },
];

function artifact(options: Partial<CommanderModel> = {}): CommanderModel {
  const tensors: CommanderModel["tensors"] = {};
  const tensor = (name: string, shape: number[]) => {
    tensors[name] = {
      shape,
      values: Array(shape.reduce((a, b) => a * b, 1)).fill(0),
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
  tensor("names.weight", [3, 16]);
  tensor("slots.weight", [16, 16]);
  tensor("kindEmbedding.weight", [11, 16]);
  tensor("queueSpecialKeys", [4, 64]);
  tensor("roleSpecialKeys", [4, 64]);
  if (options.encoding === "graph-plan-v3") {
    tensor("editGate.weight", [5, 128]);
    tensor("editGate.bias", [5]);
  }
  const result: CommanderModel = {
    format: "warbook-commander-model-v1",
    schema: "commander-v1",
    encoding: "graph-plan-v4",
    hidden: 128,
    temperature: 0.01,
    vocabulary: ["MTNK", "AMCV"],
    tensors,
    ...options,
  };
  if (options.memberScoring && options.memberScoring.mode !== "separate-v1") {
    result.format = options.format ?? "warbook-commander-model-v2";
    result.actionEncoding = options.actionEncoding ?? result.encoding;
    delete result.encoding;
  }
  return result;
}

function withScoring(
  source: CommanderModel,
  memberScoring: MemberScoring,
): CommanderModel {
  const { encoding, actionEncoding, ...rest } = source;
  return memberScoring.mode === "separate-v1"
    ? {
        ...rest,
        format: "warbook-commander-model-v1",
        encoding: encoding ?? actionEncoding,
        memberScoring,
      }
    : {
        ...rest,
        format: "warbook-commander-model-v2",
        actionEncoding: encoding ?? actionEncoding,
        memberScoring,
      };
}

function world(empty = false): CommanderWorld {
  const tank: Unit = {
    ref: "member",
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
  const o: Observation = {
    tick: 0,
    side: 0,
    credits: 10000,
    power: { total: 200, drain: 100, isLowPower: false },
    home: { x: 20, y: 20 },
    starts: [
      { x: 20, y: 20 },
      { x: 80, y: 80 },
      { x: 110, y: 30 },
    ],
    own: empty
      ? []
      : [
          tank,
          { ...tank, ref: "other" },
          { ...tank, ref: "reserve" },
          { ...tank, ref: "native" },
          { ...tank, ref: "deploy", name: "AMCV", mcv: true, combat: false },
        ],
    enemies: [],
    products: [{ name: "MTNK", type: 7, queue: 3, cost: 700 }],
    queues: Array.from({ length: 6 }, (_, type) => ({
      type,
      status: 0,
      size: 0,
      items: [],
    })),
    buildSites: [],
  };
  const state = initialProgram();
  state.slots[0] = {
    active: true,
    kind: "advance",
    goal: { x: 80, y: 80, kind: "start" },
    allowCrush: true,
    interrupt: false,
    since: 0,
  };
  state.slots[6] = {
    active: true,
    kind: "assemble",
    goal: { x: 80, y: 80, kind: "start" },
    allowCrush: true,
    interrupt: false,
    since: 0,
  };
  state.roles.set("member", 0);
  state.roles.set("other", 6);
  state.roles.set("reserve", RESERVE);
  state.roles.set("deploy", DEPLOY);
  return buildWorld(o, state, new ContactMemory());
}

const close = (actual: number, expected: number, tolerance = 1e-12) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`,
  );
const score = (
  model: NeuralCommanderPolicy,
  w: CommanderWorld,
  action = keepAction(w),
) =>
  model.predict(
    w,
    Array(128).fill(0),
    () => {
      throw new Error("Forced score sampled");
    },
    false,
    action,
  );

function checkRecordedProbabilityMath(prediction: CommanderPrediction) {
  let logp = 0,
    entropy = 0,
    factors = 0;
  for (const [head, rows] of Object.entries(prediction.probabilities!)) {
    const indexed = /^(queue|amount|cash|place)(\d)$/.exec(head);
    const actionField = indexed
      ? (
          {
            queue: "queues",
            amount: "amounts",
            cash: "cash",
            place: "placements",
          } as const
        )[indexed[1] as "queue" | "amount" | "cash" | "place"]
      : (
          {
            kind: "kinds",
            goal: "goals",
            engagement: "engagement",
            unit: "units",
            building: "buildings",
          } as const
        )[head as "kind" | "goal" | "engagement" | "unit" | "building"];
    rows.forEach((probabilities, i) => {
      close(
        probabilities.reduce((a, b) => a + b, 0),
        1,
      );
      const selected =
        prediction.action[actionField][indexed ? Number(indexed[2]) : i];
      assert.ok(probabilities[selected] > 0);
      if (probabilities.filter((p) => p > 0).length > 1) {
        factors++;
        logp += Math.log(probabilities[selected]);
        entropy -= probabilities.reduce(
          (sum, p) => sum + (p ? p * Math.log(p) : 0),
          0,
        );
      }
    });
  }
  close(prediction.logp, logp, 1e-10);
  close(prediction.entropy, entropy / Math.max(1, factors));
}

test("member scoring modes have strict fields and only experiments require v4", () => {
  for (const encoding of [
    "graph-plan-v1",
    "graph-plan-v2",
    "graph-plan-v3",
    "graph-plan-v4",
  ] as const) {
    assert.deepEqual(resolveMemberScoring(encoding), { mode: "separate-v1" });
    assert.deepEqual(resolveMemberScoring(encoding, MODES[0]), MODES[0]);
    for (const mode of MODES.slice(1)) {
      if (encoding === "graph-plan-v4")
        assert.deepEqual(resolveMemberScoring(encoding, mode), mode);
      else
        assert.throws(
          () => resolveMemberScoring(encoding, mode),
          /graph-plan-v4/,
        );
    }
  }
  for (const raw of [
    null,
    [],
    true,
    "separate-v1",
    {},
    { mode: "unknown" },
    { mode: "separate-v1", bias: 0 },
    { mode: "current-task-keep-v1", bias: 0 },
    { mode: "keep-bias-v1" },
    { mode: "keep-bias-v1", bias: 0, extra: true },
    ...[NaN, Infinity, -1, "1", true, null].map((bias) => ({
      mode: "keep-bias-v1",
      bias,
    })),
  ])
    assert.throws(
      () => resolveMemberScoring("graph-plan-v4", raw),
      /member scoring/i,
    );
  assert.throws(() =>
    resolveMemberScoring("graph-plan-v4", {
      mode: "separate-v1",
      [Symbol("extra")]: true,
    }),
  );
  assert.deepEqual(
    resolveMemberScoring("graph-plan-v4", { mode: "keep-bias-v1", bias: 0 }),
    { mode: "keep-bias-v1", bias: 0 },
  );
  assert.throws(
    () =>
      new NeuralCommanderPolicy(
        artifact({ encoding: "graph-plan-v2", memberScoring: MODES[1] }),
      ),
    /graph-plan-v4/,
  );
  const raw: MemberScoring = { mode: "keep-bias-v1", bias: 2 };
  const model = new NeuralCommanderPolicy(artifact({ memberScoring: raw }));
  try {
    assert.deepEqual(model.memberScoring, raw);
    assert.ok(Object.isFrozen(model.memberScoring));
    raw.bias = 9;
    assert.deepEqual(model.memberScoring, { mode: "keep-bias-v1", bias: 2 });
  } finally {
    model.dispose();
  }
});

test("artifact transport separates R from M/I and blocks legacy loader fallback", () => {
  const v1 = {
    format: "warbook-commander-model-v1",
    encoding: "graph-plan-v4",
  };
  const v2 = {
    format: "warbook-commander-model-v2",
    actionEncoding: "graph-plan-v4",
  };
  assert.equal(commanderArtifactEncoding(v1), "graph-plan-v4");
  assert.equal(
    commanderArtifactEncoding({ ...v1, memberScoring: MODES[0] }),
    "graph-plan-v4",
  );
  for (const memberScoring of [
    ...MODES.slice(1),
    { mode: "keep-bias-v1", bias: 0 },
  ]) {
    assert.equal(
      commanderArtifactEncoding({ ...v2, memberScoring }),
      "graph-plan-v4",
    );
    assert.throws(() => commanderArtifactEncoding({ ...v1, memberScoring }));
  }
  for (const header of [
    v2,
    { ...v2, memberScoring: MODES[0] },
    { ...v2, memberScoring: MODES[1], encoding: "graph-plan-v4" },
    { ...v2, memberScoring: MODES[1], encoding: undefined },
    { format: v2.format, memberScoring: MODES[1] },
    { ...v2, actionEncoding: "graph-plan-v2", memberScoring: MODES[1] },
    { ...v1, actionEncoding: "graph-plan-v4" },
    { format: v1.format },
    { ...v1, encoding: undefined },
  ])
    assert.throws(() => commanderArtifactEncoding(header));
  const source = artifact();
  assert.throws(
    () => new NeuralCommanderPolicy({ ...source, memberScoring: MODES[1] }),
  );
  assert.throws(
    () =>
      new NeuralCommanderPolicy({
        ...source,
        format: "warbook-commander-model-v2",
      }),
  );
  const experimental = withScoring(source, MODES[1]);
  assert.equal(Object.hasOwn(experimental, "encoding"), false);
  const model = new NeuralCommanderPolicy(experimental);
  try {
    assert.equal(model.encoding, "graph-plan-v4");
  } finally {
    model.dispose();
  }
});

test("eligibility preserves special, released, retyped and incompatible roles", () => {
  const w = world(),
    a = keepAction(w);
  const eligible = (i: number) =>
    memberKeepEligible(
      w,
      i,
      a.kinds,
      commanderRoleMask(w, i, a.kinds, "graph-plan-v4"),
    );
  assert.equal(eligible(0), true);
  assert.equal(eligible(1), true);
  for (const i of [2, 3, 4]) assert.equal(eligible(i), false);
  assert.equal(memberKeepEligible(w, -1, a.kinds, []), false);
  assert.equal(memberKeepEligible(w, w.unitRefs.length, a.kinds, []), false);
  assert.equal(
    memberKeepEligible(
      w,
      0,
      a.kinds,
      commanderRoleMask(w, 0, a.kinds, "graph-plan-v1"),
    ),
    false,
  );
  a.kinds[0] = 3;
  assert.equal(eligible(0), true);
  a.kinds[0] = 4;
  assert.equal(eligible(0), false);
  a.kinds[0] = 1;
  assert.equal(eligible(0), false);
  a.kinds[0] = 0;
  w.previousKinds[0] = 1;
  assert.equal(eligible(0), false);
  w.previousKinds[0] = 8;
  assert.equal(eligible(0), false);
  w.unitCapabilities[0].miner = true;
  assert.equal(eligible(0), true);
  w.unitCapabilities[0].building = true;
  assert.equal(eligible(0), false);
});

test("missing and explicit separate modes keep every legacy prediction exactly", () => {
  for (const encoding of [
    "graph-plan-v1",
    "graph-plan-v2",
    "graph-plan-v3",
    "graph-plan-v4",
  ] as CommanderEncoding[]) {
    const source = artifact({ encoding }),
      a = new NeuralCommanderPolicy(source, true),
      b = new NeuralCommanderPolicy(withScoring(source, MODES[0]), true);
    try {
      const w = world();
      assert.deepEqual(a.memberScoring, MODES[0]);
      assert.deepEqual(score(a, w), score(b, w));
      assert.deepEqual(
        a.predict(w, Array(128).fill(0), () => 0, false),
        b.predict(w, Array(128).fill(0), () => 0, false),
      );
    } finally {
      a.dispose();
      b.dispose();
    }
  }
});

test("effective-temperature merge and bias keep double precision and canonical masks", () => {
  for (const temperature of [0.01, 0.2, 1e-8]) {
    const source = artifact({ temperature }),
      w = world();
    const models = MODES.map(
      (memberScoring) =>
        new NeuralCommanderPolicy(withScoring(source, memberScoring), true),
    );
    try {
      const predictions = models.map((m) => score(m, w));
      const original = predictions[0].probabilities!.unit;
      close(original[0][KEEP_UNIT], 0.25);
      for (const p of predictions.slice(1)) {
        close(p.probabilities!.unit[0][KEEP_UNIT], 0.4);
        close(p.probabilities!.unit[0][6], 0.2);
        assert.equal(p.probabilities!.unit[0][0], 0);
        for (const i of [2, 3, 4])
          assert.deepEqual(p.probabilities!.unit[i], original[i]);
        for (const head of Object.keys(predictions[0].probabilities!))
          if (head !== "unit")
            assert.deepEqual(
              p.probabilities![head],
              predictions[0].probabilities![head],
            );
        assert.deepEqual(p.hidden, predictions[0].hidden);
        assert.equal(p.value, predictions[0].value);
        checkRecordedProbabilityMath(p);
      }
      // Casting the adjusted T*log(2) score through float32 would fail 1e-12.
      const recast = Math.fround(temperature * Math.log(2));
      assert.ok(
        Math.abs(1 / (1 + 3 * Math.exp(-recast / temperature)) - 0.4) > 1e-12,
      );
    } finally {
      models.forEach((m) => m.dispose());
    }
  }
});

test("zero bias and entirely noneligible worlds keep the original path exactly", () => {
  const source = artifact(),
    w = world(),
    fixed = keepAction(w);
  const original = new NeuralCommanderPolicy(source, true),
    zero = new NeuralCommanderPolicy(
      withScoring(source, { mode: "keep-bias-v1", bias: 0 }),
      true,
    );
  try {
    assert.deepEqual(score(original, w), score(zero, w));
  } finally {
    zero.dispose();
  }
  fixed.kinds[0] = 4;
  fixed.kinds[6] = 4;
  fixed.units[0] = 0;
  fixed.units[1] = 6;
  for (const memberScoring of MODES.slice(1)) {
    const changed = new NeuralCommanderPolicy(
      withScoring(source, memberScoring),
      true,
    );
    try {
      assert.deepEqual(score(original, w, fixed), score(changed, w, fixed));
      assert.deepEqual(
        score(original, world(true)),
        score(changed, world(true)),
      );
    } finally {
      changed.dispose();
    }
  }
  original.dispose();
});

test("sampling, greedy choice, forced score and exported probabilities use the same distribution", () => {
  const w = world();
  for (const memberScoring of MODES) {
    const model = new NeuralCommanderPolicy(artifact({ memberScoring }), true);
    try {
      for (const deterministic of [false, true]) {
        const prediction = model.predict(
          w,
          Array(128).fill(0),
          () => 0,
          deterministic,
        );
        const rescored = score(model, w, prediction.action);
        assert.deepEqual(prediction, rescored);
        checkRecordedProbabilityMath(prediction);
        if (deterministic && memberScoring.mode !== "separate-v1")
          assert.equal(prediction.action.units[0], KEEP_UNIT);
      }
    } finally {
      model.dispose();
    }
  }
});

test("only dynamic KEEP senses its current task's newly selected same-kind goal", () => {
  const source = artifact(),
    w = world();
  source.tensors["unitQuery.bias"].values[0] = Math.atanh(0.5);
  source.tensors["goal0.weight"].values[0] = 1;
  source.tensors["roleKeys.weight"].values[64] = 1;
  const a = keepAction(w);
  a.kinds[0] = 3;
  a.goals[0] = w.goalObjects.findIndex((g) => g.kind === "start" && g.x === 80);
  const b = structuredClone(a);
  b.goals[0] = w.goalObjects.findIndex(
    (g) => g.kind === "start" && g.x === 110,
  );
  assert.ok(a.goals[0] >= 0 && b.goals[0] >= 0);
  for (const memberScoring of MODES) {
    const model = new NeuralCommanderPolicy(
      withScoring(source, memberScoring),
      true,
    );
    try {
      const first = score(model, w, a),
        second = score(model, w, b);
      const p = first.probabilities!.unit,
        q = second.probabilities!.unit;
      assert.deepEqual(first.hidden, second.hidden);
      if (memberScoring.mode === "current-task-keep-v1")
        assert.ok(Math.abs(p[0][KEEP_UNIT] - q[0][KEEP_UNIT]) > 1e-3);
      else assert.deepEqual(p[0], q[0]);
      assert.notDeepEqual(p[1], q[1]);
      assert.equal(p[0][0], 0);
      assert.equal(q[0][0], 0);
    } finally {
      model.dispose();
    }
  }
});
