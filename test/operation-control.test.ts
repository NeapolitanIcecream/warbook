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
  applyLaunchOnly,
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
  ExperimentalOperationProvider,
} from "../src/learning/operation.js";
import { chooseMenuTeacher } from "../src/control/operation-teacher.js";
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

test("target-clear observation between policy ticks persists until a new order or visible target", () => {
  const c = context();
  commit(c, advance, ["u0", "u1"]);
  c.observation.tick += 3;
  c.observation.enemies = [];
  c.observation.vacatedContacts = ["base"];
  observeArmor(c.state, c.observation);
  c.observation.tick += 72;
  c.observation.vacatedContacts = [];
  c.operations.observe(c.observation, []);
  assert(buildOperationSnapshot(c, "operation").operation.cleared);
  c.observation.enemies = [
    {
      ref: "base",
      name: "GAWEAP",
      type: 2,
      x: 90,
      y: 2,
      hp: 1000,
      maxHp: 1000,
      observedTick: c.observation.tick,
    },
  ];
  observeArmor(c.state, c.observation);
  assert.equal(c.state.goalCleared, false);
});

test("launch-only preserves old returning units and permits a fresh wave, as v1 does", () => {
  const c = context();
  commit(c, withdraw, ["u0"]);
  c.observation.own[0].x = 40;
  c.reserve = c.observation.own.slice(1);
  const s = buildOperationSnapshot(c, "launch");
  const index = s.actions.findIndex(
    (a) => a.order?.kind === "advance" && a.addRefs.length === 7,
  );
  assert(index > 0);
  const before = copyArmorState(c.state);
  applyLaunchOnly(c.state, s.actions[index], c.observation, c.reserve);
  const after = copyArmorState(c.state);
  assert.equal(
    matchTeacher(
      { ...c, state: before, advice: { ...c.advice, state: after } },
      s,
    ).action,
    index,
  );
  assert.deepEqual([...c.state.withdrawing], ["u0"]);
  assert.deepEqual(c.state.withdrawalPoint, withdraw.goal.point);
  assert.equal(c.state.assault.size, 7);
  assert.equal(c.state.order?.kind, "advance");
  assert.throws(
    () => applyLaunchOnly(c.state, s.actions[index], c.observation, c.reserve),
    /existing force/,
  );
});

test("Bastion launch-only model can attack with reserves while a depleted previous wave returns", () => {
  const o = observation();
  let first = true;
  const provider: OperationProvider = {
    scope: "launch",
    period: 75,
    teacher: false,
    choose(c) {
      if (first) {
        first = false;
        return {
          kind: "apply",
          order: advance,
          addRefs: ["u0", "u1", "u2"],
          expectedStateVersion: c.state.stateVersion,
        };
      }
      const s = buildOperationSnapshot(c, "launch");
      const a = s.actions
        .filter((a) => a.order?.kind === "advance")
        .sort((a, b) => b.addRefs.length - a.addRefs.length)[0];
      assert(a);
      return a;
    },
  };
  const strategy = new BastionStrategy("bastion", undefined, provider),
    tactics = new LocalCombat();
  const plan = () =>
    strategy.plan(o, tactics.assess(o, strategy.assessmentRequest(o)));
  assert.equal(plan().combat.units.length, 3);
  o.tick += 75;
  o.ownDepartures = ["u1", "u2"];
  o.own = o.own.filter((u) => !o.ownDepartures!.includes(u.ref));
  o.own[0].x = 40;
  const next = plan();
  assert.equal(next.combat.kind, "advance");
  assert.equal(next.combat.units.length, 5);
  assert(!next.combat.units.includes("u0"));
  assert.deepEqual(
    next.additionalCombat?.find((m) => m.id === "recover-force")?.units,
    ["u0"],
  );
});

test("launch-only keeps v1 protection against immediate recall on unchanged evidence", () => {
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
  o.enemies.push({
    ref: "intruder",
    name: "MTNK",
    type: 7,
    x: 11,
    y: 2,
    hp: 300,
    maxHp: 300,
    observedTick: o.tick,
    weaponRange: 5,
  });
  let first = true;
  const provider: OperationProvider = {
    scope: "launch",
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
  assert.equal(plan().combat.units.length, 8);
  o.tick += 75;
  o.own.find((u) => u.ref === "refinery")!.hp = 500;
  assert(
    (plan().additionalCombat?.find((m) => m.id === "base-relief")?.units
      .length ?? 0) > 0,
  );
});

test("a remembered hidden target keeps its legal risk estimate without an object attack", () => {
  const c = context();
  c.observation.enemies.push(
    ...Array.from({ length: 20 }, (_, i) => ({
      ref: `e${i}`,
      name: "MTNK",
      type: 7,
      x: 85,
      y: 2,
      hp: 300,
      maxHp: 300,
      observedTick: c.observation.tick,
      weaponRange: 5,
    })),
  );
  c.operations.observe(c.observation, []);
  commit(c, advance, ["u0", "u1"]);
  c.observation.enemies = [];
  const operation = describeOperation(c.state, c.operations, c.observation);
  assert.equal(operation?.reason, "formed-pressure");
  assert.equal(operation?.ref, undefined);
  assert((operation?.defenders ?? 0) >= 20);
});

test("shared flanking remains subordinate to a model advance and stops when it defends", () => {
  const o = observation();
  o.own = Array.from({ length: 12 }, (_, i) =>
    unit(`u${i}`, 2 + (i % 4), 2 + Math.floor(i / 4)),
  );
  o.enemies.push(
    ...Array.from({ length: 25 }, (_, i) => ({
      ref: `e${i}`,
      name: "MTNK",
      type: 7,
      x: 85,
      y: 2,
      hp: 300,
      maxHp: 300,
      observedTick: o.tick,
      weaponRange: 5,
    })),
  );
  o.flankApproach = {
    towards: advance.goal.point,
    point: { x: 60, y: 20 },
    observedTick: o.tick,
  };
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
          addRefs: c.reserve.map((u) => u.ref),
          expectedStateVersion: c.state.stateVersion,
        };
      }
      return {
        kind: "apply",
        order: {
          kind: "defend",
          goal: {
            key: "defend:5:5:false",
            point: { x: 5, y: 5 },
            kind: "anchor",
          },
        },
        addRefs: [],
        expectedStateVersion: c.state.stateVersion,
      };
    },
  };
  const strategy = new BastionStrategy("bastion", undefined, provider),
    tactics = new LocalCombat();
  const plan = () =>
    strategy.plan(o, tactics.assess(o, strategy.assessmentRequest(o)));
  const firstPlan = plan();
  assert.equal(firstPlan.combat.units.length, 6);
  assert.equal(
    firstPlan.additionalCombat?.find((m) => m.id === "flank-force")?.units
      .length,
    6,
  );
  o.tick += 75;
  const next = plan();
  assert.equal(next.combat.kind, "defend");
  assert.equal(next.combat.units.length, 12);
  assert(!next.additionalCombat?.some((m) => m.id === "flank-force"));
});

test("binding a visible building at a search point is an explicit teacher action, not KEEP", () => {
  const c = context();
  commit(
    c,
    {
      kind: "advance",
      goal: { key: "90:2:false", point: { x: 90, y: 2 }, kind: "search" },
    },
    ["u0", "u1"],
  );
  c.reserve = c.observation.own.slice(2);
  c.advice.state = copyArmorState(c.state);
  c.advice.state.order = advance;
  const snapshot = buildOperationSnapshot(c, "operation"),
    match = matchTeacher(c, snapshot);
  assert(match.action > 0);
  assert.equal(snapshot.actions[match.action].order?.goal.ref, "base");
  assert.equal(snapshot.actions[match.action].addRefs.length, 0);
});

test("menu teacher reuses arrived withdrawal members rather than waiting for an empty slot", () => {
  const c = context();
  c.observation.own.forEach((u) => {
    u.x = 2;
    u.y = 2;
  });
  commit(
    c,
    withdraw,
    c.observation.own.map((u) => u.ref),
  );
  c.reserve = [];
  c.observation.tick += 600;
  const menu = buildOperationSnapshot(c, "operation"),
    teacher = chooseMenuTeacher(c, menu);
  assert.equal(menu.actions[teacher.action].order?.kind, "advance");
  assert.equal(teacher.reason, "menu-v1:relaunch-owned-force");
  applyOperation(
    c.state,
    menu.actions[teacher.action],
    c.observation,
    c.reserve,
    "teacher",
  );
  assert.equal(authorizedArmor(c.state).size, 8);
  assert.equal(c.state.withdrawing.size, 0);
  assert.equal(c.state.lastCommit?.source, "teacher");
});

test("menu teacher keeps travelling withdrawal then assembles its surviving cohort", () => {
  const c = context();
  commit(c, withdraw, ["u0", "u1"]);
  c.reserve = [];
  c.observation.own = c.observation.own.slice(0, 2);
  c.observation.own.forEach((u) => {
    u.x = 40;
    u.y = 40;
  });
  c.observation.tick += 600;
  let menu = buildOperationSnapshot(c, "operation");
  assert.equal(chooseMenuTeacher(c, menu).action, 0);
  c.observation.own.forEach((u) => {
    u.x = 2;
    u.y = 2;
  });
  menu = buildOperationSnapshot(c, "operation");
  const chosen = menu.actions[chooseMenuTeacher(c, menu).action];
  assert.equal(chosen.order?.kind, "assemble");
  assert.equal(chosen.addRefs.length, 0);
});

test("menu teacher explicitly replaces partial recall with an executable whole-force order", () => {
  const c = context();
  commit(c, advance, ["u0", "u1", "u2", "u3"]);
  c.reserve = c.observation.own.slice(4);
  c.advice.recalled = ["u0"];
  const menu = buildOperationSnapshot(c, "operation"),
    teacher = chooseMenuTeacher(c, menu);
  assert.equal(menu.actions[teacher.action].order?.kind, "defend");
  applyOperation(
    c.state,
    menu.actions[teacher.action],
    c.observation,
    c.reserve,
    "teacher",
  );
  for (const ref of ["u0", "u1", "u2", "u3"])
    assert.ok(authorizedArmor(c.state).has(ref));
});

test("menu teacher deployment follows the current defended approach", () => {
  const c = context();
  commit(
    c,
    {
      kind: "defend",
      goal: { key: "defend-old", point: { x: 3, y: 3 }, kind: "anchor" },
    },
    ["u0", "u1"],
  );
  c.reserve = c.observation.own.slice(2);
  c.frame.protectNow = true;
  c.anchors.defend = [{ x: 18, y: 18 }];
  const menu = buildOperationSnapshot(c, "operation"),
    choice = chooseMenuTeacher(c, menu);
  assert.deepEqual(menu.actions[choice.action].order?.goal.point, {
    x: 18,
    y: 18,
  });
});

test("menu teacher uses actual order kind and the policy executor, with no dropped label", () => {
  const c = context();
  commit(
    c,
    {
      kind: "assemble",
      goal: {
        key: "assemble:3:3:false",
        point: { x: 3, y: 3 },
        kind: "anchor",
      },
    },
    c.observation.own.map((u) => u.ref),
  );
  c.reserve = [];
  const provider = new ExperimentalOperationProvider(
    "operation",
    "teacher-menu",
    "47",
  );
  const action = provider.choose(c);
  assert.equal(provider.teacher, false);
  assert.equal(provider.executionSource, "teacher");
  assert.equal(action.order?.kind, "advance");
  assert.equal(provider.record?.action, provider.record?.teacherAction);
  assert.ok(provider.record!.action >= 0);
});

test("menu teacher holds an existing assembly instead of alternating fallback anchors without reserves", () => {
  const c = context();
  c.observation.own = c.observation.own.slice(0, 2);
  c.anchors.assemble = [
    { x: 3, y: 3 },
    { x: 10, y: 10 },
  ];
  commit(
    c,
    {
      kind: "assemble",
      goal: {
        key: "assemble:3:3:false",
        point: { x: 3, y: 3 },
        kind: "anchor",
      },
    },
    ["u0", "u1"],
  );
  c.reserve = [];
  const menu = buildOperationSnapshot(c, "operation"),
    teacher = chooseMenuTeacher(c, menu);
  assert.equal(teacher.action, 0);
  c.anchors.assemble = [
    { x: 4, y: 4 },
    { x: 10, y: 10 },
  ];
  assert.equal(
    chooseMenuTeacher(c, buildOperationSnapshot(c, "operation")).action,
    0,
  );
});
