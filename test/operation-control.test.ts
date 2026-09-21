import { test } from "node:test";
import assert from "node:assert/strict";
import type { Observation, Unit } from "../src/model.js";
import {
  armorState,
  authorizedArmor,
  copyArmorState,
  type OperationOrder,
} from "../src/control/armor-state.js";
import {
  applyOperation,
  observeArmor,
  describeOperation,
} from "../src/control/operation-state.js";
import { Operations } from "../src/control/operations.js";
import type {
  OperationContext,
  OperationProvider,
} from "../src/control/operation-provider.js";
import {
  buildOperationSnapshot,
  matchTeacher,
  OPERATION_GLOBAL_SIZE,
} from "../src/learning/operation.js";
import { BastionStrategy } from "../src/control/bastion-strategy.js";
import { LocalCombat } from "../src/control/tactics.js";

const unit = (ref: string, x = 3, y = 3): Unit => ({
  ref,
  name: "MTNK",
  type: 7,
  x,
  y,
  hp: 300,
  maxHp: 300,
  width: 1,
  height: 1,
  mobile: true,
  idle: false,
  harvester: false,
  mcv: false,
  yard: false,
  refinery: false,
  combat: true,
  weaponRange: 5,
});
const observation = (): Observation => ({
  tick: 6000,
  side: 0,
  credits: 2000,
  power: { total: 200, drain: 100, isLowPower: false },
  home: { x: 0, y: 0 },
  starts: [
    { x: 0, y: 0 },
    { x: 90, y: 2 },
  ],
  own: Array.from({ length: 8 }, (_, i) =>
    unit(`u${i}`, 2 + (i % 3), 2 + Math.floor(i / 3)),
  ),
  enemies: [
    {
      ref: "base",
      name: "GAWEAP",
      type: 2,
      x: 90,
      y: 2,
      hp: 1000,
      maxHp: 1000,
      observedTick: 6000,
    },
  ],
  products: [],
  queues: [],
  buildSites: [],
});
const advance: OperationOrder = {
  kind: "advance",
  goal: { key: "base", ref: "base", kind: "GAWEAP", point: { x: 90, y: 2 } },
};
const withdraw: OperationOrder = {
  kind: "withdraw",
  goal: { key: "withdraw:0:0:false", kind: "anchor", point: { x: 0, y: 0 } },
};
function context(): OperationContext {
  const o = observation(),
    operations = new Operations(),
    state = armorState();
  operations.observe(o, []);
  return {
    observation: o,
    state,
    operations,
    reserve: o.own,
    anchors: {
      assemble: [{ x: 3, y: 3 }],
      defend: [{ x: 5, y: 5 }],
      withdraw: [{ x: 0, y: 0 }],
    },
    frame: {
      o,
      vehicles: o.own,
      armor: "MTNK",
      post: { x: 3, y: 3 },
      musterPost: { x: 3, y: 3 },
      stagingDirection: { x: 90, y: 2 },
      protectNow: false,
      firstForceFunded: true,
      hasScouts: true,
      searchGoal: { x: 90, y: 2 },
      launchSize: 6,
      hadAssault: false,
      threatKeys: [],
      outsideFactory: () => true,
      covered: () => false,
    },
    advice: {
      state: copyArmorState(state),
      operations: operations.planningCopy(),
      recalled: [],
    },
  };
}
const commit = (c: OperationContext, order: OperationOrder, refs: string[]) =>
  applyOperation(
    c.state,
    {
      kind: "apply",
      order,
      addRefs: refs,
      expectedStateVersion: c.state.stateVersion,
    },
    c.observation,
    c.reserve,
  );

test("persistent group can reverse withdrawal and reinforce atomically; KEEP does not reset ages", () => {
  const c = context();
  commit(c, advance, ["u0", "u1"]);
  c.reserve = c.observation.own.slice(2);
  c.observation.tick += 75;
  commit(c, withdraw, []);
  c.observation.tick += 75;
  commit(c, advance, ["u2"]);
  assert.deepEqual([...authorizedArmor(c.state)].sort(), ["u0", "u1", "u2"]);
  assert.equal(c.state.withdrawing.size, 0);
  assert.equal(c.state.order?.kind, "advance");
  assert.deepEqual([...c.state.joining], ["u2"]);
  const before = copyArmorState(c.state);
  applyOperation(
    c.state,
    { kind: "keep", addRefs: [], expectedStateVersion: c.state.stateVersion },
    c.observation,
    c.reserve,
  );
  assert.deepEqual(c.state, before);
  assert.throws(
    () =>
      applyOperation(
        c.state,
        { kind: "apply", addRefs: ["u3"], expectedStateVersion: -1 },
        c.observation,
        c.reserve,
      ),
    /Stale/,
  );
});
test("arrived withdrawal and temporarily absent own units remain authorized; only confirmed losses retire", () => {
  const c = context();
  commit(c, withdraw, ["u0", "u1"]);
  c.observation.own = [unit("u0", 0, 0)];
  observeArmor(c.state, c.observation);
  assert.equal(authorizedArmor(c.state).size, 2);
  assert.equal(c.state.order?.kind, "withdraw");
  c.observation.ownDepartures = ["u1"];
  observeArmor(c.state, c.observation);
  assert.deepEqual([...authorizedArmor(c.state)], ["u0"]);
});
test("orphan reinforcements become main and a cleared target never triggers strategic return", () => {
  const c = context();
  commit(c, advance, ["u0"]);
  c.reserve = c.observation.own.slice(1);
  applyOperation(
    c.state,
    {
      kind: "apply",
      addRefs: ["u1"],
      expectedStateVersion: c.state.stateVersion,
    },
    c.observation,
    c.reserve,
  );
  c.observation.ownDepartures = ["u0"];
  c.observation.own = [unit("u1", 90, 2)];
  c.observation.enemies = [];
  c.observation.vacatedContacts = ["base"];
  observeArmor(c.state, c.observation);
  c.operations.observe(c.observation, []);
  assert.deepEqual([...c.state.assault], ["u1"]);
  assert.equal(c.state.joining.size, 0);
  const operation = describeOperation(c.state, c.operations, c.observation);
  assert.deepEqual(operation?.point, advance.goal.point);
  assert.equal(operation?.ref, undefined);
  c.reserve = [];
  const snapshot = buildOperationSnapshot(c, "operation");
  assert(snapshot.operation.cleared);
  assert(snapshot.actions.some((a) => a.order?.kind === "withdraw"));
  assert(snapshot.actions.some((a) => a.order?.kind === "defend"));
});
test("bounded shared facts expose ongoing actions without reserves; disconnected members do not veto everybody", () => {
  const c = context();
  commit(c, advance, ["u0", "u1"]);
  c.reserve = [];
  const full = buildOperationSnapshot(c, "operation"),
    narrow = buildOperationSnapshot(c, "launch");
  assert.equal(full.global.length, OPERATION_GLOBAL_SIZE);
  assert.deepEqual(full.global, narrow.global);
  assert.equal(narrow.actions.length, 1);
  assert(full.actions.length > 1 && full.actions.length <= 75);
  assert(
    full.candidates.every((f) => f.length === 48 && f.every(Number.isFinite)),
  );
  c.observation.launchGeometry = [
    { ...c.observation.own[0], region: 1 },
    { ...c.observation.own[1], region: 2 },
    { x: 5, y: 5, region: 2 },
  ];
  assert(
    buildOperationSnapshot(c, "operation").actions.some(
      (a) => a.order?.kind === "defend",
    ),
  );
});
test("teacher partial recall or mismatching reinforcement count cannot become a fake KEEP", () => {
  const c = context();
  commit(c, advance, ["u0", "u1"]);
  c.reserve = c.observation.own.slice(2);
  c.advice.state = copyArmorState(c.state);
  c.advice.state.assault.delete("u0");
  c.advice.recalled = ["u0"];
  assert.equal(
    matchTeacher(c, buildOperationSnapshot(c, "operation")).action,
    -1,
  );
  c.advice.state = copyArmorState(c.state);
  c.advice.recalled = [];
  assert.equal(
    matchTeacher(c, buildOperationSnapshot(c, "operation")).action,
    0,
  );
});
test("fresh home damage and two surviving tanks cannot steal or retreat the model-owned force", () => {
  const o = observation();
  o.own.push({
    ...unit("refinery", 0, 0),
    name: "GAREFN",
    type: 2,
    width: 3,
    height: 3,
    mobile: false,
    refinery: true,
    combat: false,
    hp: 1000,
    maxHp: 1000,
  });
  let first = true;
  const provider: OperationProvider = {
    scope: "operation",
    period: 75,
    teacher: false,
    choose(c) {
      if (first) {
        first = false;
        return {
          kind: "apply",
          order: advance,
          addRefs: c.reserve.filter((u) => u.name === "MTNK").map((u) => u.ref),
          expectedStateVersion: c.state.stateVersion,
        };
      }
      return {
        kind: "keep",
        addRefs: [],
        expectedStateVersion: c.state.stateVersion,
      };
    },
  };
  const strategy = new BastionStrategy("bastion", undefined, provider),
    tactics = new LocalCombat();
  const plan = () =>
    strategy.plan(o, tactics.assess(o, strategy.assessmentRequest(o)));
  assert.equal(plan().combat.units.length, 8);
  o.tick += 75;
  o.ownDepartures = ["u2", "u3", "u4", "u5", "u6", "u7"];
  o.own = o.own.filter((u) => !o.ownDepartures!.includes(u.ref));
  o.own.find((u) => u.ref === "refinery")!.hp = 500;
  o.enemies.push({
    ref: "intruder",
    name: "MTNK",
    type: 7,
    x: 4,
    y: 4,
    hp: 300,
    maxHp: 300,
    observedTick: o.tick,
    weaponRange: 5,
  });
  const next = plan();
  assert.equal(next.combat.kind, "advance");
  assert.deepEqual([...next.combat.units].sort(), ["u0", "u1"]);
  assert(
    !next.additionalCombat?.some(
      (m) =>
        m.id === "base-relief" && m.units.some((r) => r === "u0" || r === "u1"),
    ),
  );
});
test("changing purpose clears stale flanks and attack context used by production", () => {
  const c = context();
  commit(c, advance, ["u0", "u1"]);
  c.state.flankRefs.add("u0");
  c.state.flankVia = { x: 50, y: 20 };
  c.reserve = c.observation.own.slice(2);
  commit(
    c,
    {
      kind: "defend",
      goal: { key: "defend:5:5:false", kind: "anchor", point: { x: 5, y: 5 } },
    },
    [],
  );
  assert.equal(c.state.flankRefs.size, 0);
  assert.equal(c.state.flankVia, undefined);
  assert.equal(
    describeOperation(c.state, c.operations, c.observation),
    undefined,
  );
  assert.equal(c.operations.active, undefined);
  assert.equal(c.operations.decision.operationReason, "policy-defend");
});
