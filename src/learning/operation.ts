import seedrandom from "seedrandom";
import {
  OPERATION_SCHEMA,
  MANEUVER_SCHEMA,
  isOperationSchema,
} from "./schema.js";
export { OPERATION_SCHEMA, isOperationSchema } from "./schema.js";
import {
  LocalManeuvers,
  LOCAL_MAX_ACTIONS,
  isLocalManeuver,
  destinationContactFacts,
  type ManeuverScope,
} from "./local-maneuvers.js";
import {
  CONTACT_SCHEMA,
  CONTACT_SIZE,
  operationContactFacts,
  type ContactInput,
} from "./operation-contact.js";
import { distance2, type Point, type Unit } from "../model.js";
import {
  authorizedArmor,
  type OperationOrder,
} from "../control/armor-state.js";
import type {
  OperationAction,
  OperationContext,
  OperationProvider,
  OperationScope,
} from "../control/operation-provider.js";
import { pointKey, sameOrder } from "../control/operation-state.js";
import { rendezvous } from "../control/formation.js";
import { chooseMenuTeacher } from "../control/operation-teacher.js";
import {
  BASE_GLOBAL_SIZE,
  buildLaunchSnapshot,
  globalFeatures,
  hp,
  isArmor,
  launchCandidateFeatures,
  mean,
  norm,
  selectLaunchMembers,
  type LaunchAction,
  type LaunchPolicy,
  type LaunchSnapshot,
} from "./launch.js";

export const OPERATION_FACT_SIZE = 24;
export const OPERATION_STEP_SIZE = BASE_GLOBAL_SIZE + OPERATION_FACT_SIZE;
export const OPERATION_GLOBAL_SIZE = OPERATION_STEP_SIZE * 4 + 4;
export const OPERATION_CANDIDATE_SIZE = 48;
export const OPERATION_MAX_ACTIONS = 75;
export const OPERATION_SHAPE = {
  schema: OPERATION_SCHEMA,
  global: OPERATION_GLOBAL_SIZE,
  candidate: OPERATION_CANDIDATE_SIZE,
};
export function operationShape(schema: string) {
  if (!isOperationSchema(schema))
    throw new Error("Unsupported operation schema");
  return {
    ...OPERATION_SHAPE,
    schema,
    global:
      OPERATION_GLOBAL_SIZE + (schema === OPERATION_SCHEMA ? 0 : CONTACT_SIZE),
    candidate: OPERATION_CANDIDATE_SIZE + (schema === MANEUVER_SCHEMA ? 2 : 0),
  };
}
type Offer = OperationAction & LaunchAction;
export interface OperationSnapshot extends LaunchSnapshot {
  actions: Offer[];
  scope: OperationScope;
  operation: {
    id: number;
    kind?: string;
    goal?: string;
    age: number;
    members: number;
    cleared: boolean;
  };
}
export interface OperationRecord extends OperationSnapshot {
  schema: string;
  contactInput?: ContactInput;
  maneuverScope?: ManeuverScope;
  action: number;
  teacherAction: number;
  teacherCoverage: string;
  logp: number;
  value: number;
  trainable: boolean;
  policy: string;
  executionSource: "policy" | "teacher";
  delegatedChange?: OperationContext["delegatedChange"];
}
const kinds = ["advance", "assemble", "defend", "withdraw"] as const;
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));
const samePurpose = (a?: OperationOrder, b?: OperationOrder) =>
  (!a && !b) ||
  (!!a &&
    !!b &&
    a.kind === b.kind &&
    pointKey(a.goal.point) === pointKey(b.goal.point) &&
    a.goal.ref === b.goal.ref);

export function operationFacts(c: OperationContext): {
  features: number[];
  cleared: boolean;
} {
  const { state: s, observation: o } = c,
    owned = authorizedArmor(s);
  const force = o.own.filter((u) => owned.has(u.ref)),
    center = force.length ? rendezvous(force, true) : o.home;
  const goal = s.order?.goal,
    target = goal?.ref && c.operations.contacts.find((e) => e.ref === goal.ref);
  const visible = !!goal?.ref && o.enemies.some((e) => e.ref === goal.ref);
  const cleared =
    s.goalCleared ||
    (!!goal &&
      (goal.ref
        ? (o.vacatedContacts ?? []).includes(goal.ref) ||
          (!target && force.some((u) => distance2(u, goal.point) <= 4 ** 2))
        : goal.kind === "search" &&
          force.some((u) => distance2(u, goal.point) <= 4 ** 2) &&
          !(o.armySearchPoints ?? []).some(
            (p) => pointKey(p) === pointKey(goal.point),
          )));
  const cohort = force.filter((u) => s.orderCohort.has(u.ref));
  return {
    cleared,
    features: [
      Number(!!s.order),
      ...kinds.map((k) => Number(s.order?.kind === k)),
      norm(owned.size, 24),
      norm(s.assault.size, 24),
      norm(s.joining.size, 24),
      norm(s.withdrawing.size, 24),
      norm(owned.size - force.length, 24),
      mean(force.map(hp)),
      force.length ? Math.min(...force.map(hp)) : 0,
      s.order ? norm(o.tick - s.orderStartedTick, 54000) : 0,
      s.order ? norm(o.tick - s.operationStartedTick, 54000) : 0,
      cohort.length / Math.max(1, s.orderCohort.size),
      norm(center.x - o.home.x, 128),
      norm(center.y - o.home.y, 128),
      goal ? norm(Math.sqrt(distance2(center, goal.point)), 128) : 0,
      goal
        ? cohort.filter((u) => distance2(u, goal.point) <= 4 ** 2).length /
          Math.max(1, cohort.length)
        : 0,
      force.filter((u) => !u.mobile).length / Math.max(1, force.length),
      Number(cleared),
      Number(visible),
      target ? norm(o.tick - target.observedTick, 54000) : 0,
      force.filter((u) => (u.attackState ?? 0) >= 3).length /
        Math.max(1, force.length),
    ],
  };
}

/** Both scopes see the same facts. Only the set of permitted transactions differs. */
export function buildOperationSnapshot(
  c: OperationContext,
  scope: OperationScope,
  localOrders: readonly OperationOrder[] = [],
): OperationSnapshot {
  if (localOrders.length > 2) throw new Error("At most two local maneuvers");
  const o = c.observation,
    s = c.state,
    owned = authorizedArmor(s);
  const force = o.own.filter((u) => owned.has(u.ref));
  const reserve = c.reserve.filter((u) => isArmor(u) && u.mobile);
  const all = [...force, ...reserve],
    known = c.operations.contacts;
  const regions = new Map(
    (o.launchGeometry ?? []).map((p) => [pointKey(p), p.region]),
  );
  const reachable = (u: Unit, p: Point) =>
    regions.get(pointKey(u)) === undefined ||
    regions.get(pointKey(p)) === undefined ||
    regions.get(pointKey(u)) === regions.get(pointKey(p));
  const facts = operationFacts(c),
    current = s.order;
  const commandCurrent = scope === "operation" ? current : undefined;
  const commandForce = scope === "operation" ? force : [];
  const commandMembers = scope === "operation" ? owned.size : 0;
  const snapshot: OperationSnapshot = {
    tick: o.tick,
    scope,
    global: [
      ...Array(OPERATION_STEP_SIZE * 3).fill(0),
      ...globalFeatures(o, reserve, known),
      ...facts.features,
      0,
      0,
      0,
      1,
    ],
    candidates: [],
    actions: [],
    targets: [],
    sourceTargets: 0,
    omittedTargets: 0,
    operation: {
      id: s.operationId,
      kind: current?.kind,
      goal: current?.goal.key,
      age: current ? o.tick - s.orderStartedTick : 0,
      members: owned.size,
      cleared: facts.cleared,
    },
  };
  const encode = (
    order: OperationOrder | undefined,
    added: readonly Unit[],
    keep = false,
  ) => {
    const affected = keep ? force : commandForce;
    const result = [...affected, ...added],
      center = result.length ? rendezvous(result, true) : o.home;
    const base =
      order && result.length
        ? launchCandidateFeatures(
            o,
            known,
            {
              point: order.goal.point,
              kind: order.goal.kind,
              contact: known.find((e) => e.ref === order.goal.ref),
            },
            keep || scope === "operation" ? all : reserve,
            result,
            center,
          )
        : Array(32).fill(0);
    const extra = [
      Number(keep),
      ...kinds.map((k) => Number(order?.kind === k)),
      Number(!sameOrder(keep ? current : commandCurrent, order)),
      norm(added.length, 24),
      norm(added.filter((u) => u.name === "SREF").length, 6),
      mean(added.map(hp)),
      norm(result.length, 24),
      norm(reserve.length - added.length, 24),
      norm(keep ? owned.size : commandMembers, 24),
      order
        ? result.filter((u) => distance2(u, order.goal.point) <= 4 ** 2)
            .length / Math.max(1, result.length)
        : 0,
      order
        ? result.filter((u) => !reachable(u, order.goal.point)).length /
          Math.max(1, result.length)
        : 0,
      Number(!keep && sameOrder(commandCurrent, order) && added.length > 0),
      Number(!!order),
    ];
    return [...base, ...extra];
  };
  snapshot.actions.push({
    kind: "keep",
    addRefs: [],
    units: [],
    expectedStateVersion: s.stateVersion,
  });
  snapshot.candidates.push(encode(current, [], true));
  // As in v1, rule-owned returning survivors do not occupy the new launch slot.
  if (scope === "launch" && (s.assault.size || s.joining.size)) return snapshot;
  const candidates = buildLaunchSnapshot({
    observation: o,
    operations: c.operations,
    ready: [],
    active: false,
    protectNow: false,
    nextLaunchTick: 0,
    firstForceFunded: c.frame.firstForceFunded,
    hasScouts: c.frame.hasScouts,
    searchGoal: c.frame.searchGoal,
    launchSize: c.frame.launchSize,
    armor: c.frame.armor,
    reserve: scope === "operation" ? all : reserve,
    slotFree: true,
  });
  snapshot.sourceTargets = candidates.sourceTargets;
  snapshot.omittedTargets = candidates.omittedTargets;
  const orders: OperationOrder[] = commandCurrent ? [commandCurrent] : [];
  const append = (order: OperationOrder) => {
    if (!orders.some((old) => sameOrder(old, order))) orders.push(order);
  };
  for (const target of candidates.targets)
    append({ kind: "advance", goal: target });
  if (scope === "operation")
    for (const kind of ["assemble", "defend", "withdraw"] as const) {
      const points = [
        ...(current?.kind === kind && !isLocalManeuver(current)
          ? [current.goal.point]
          : []),
        ...c.anchors[kind],
      ];
      const unique = new Map(points.map((p) => [pointKey(p), p]));
      for (const point of [...unique.values()]
        .filter((p) => !c.frame.covered(p))
        .filter(
          (p) =>
            !(
              kind === "withdraw" &&
              isLocalManeuver(current) &&
              pointKey(p) === pointKey(current!.goal.point)
            ),
        )
        .slice(0, 2))
        append({
          kind,
          goal: { key: `${kind}:${pointKey(point)}`, point, kind: "anchor" },
        });
    }
  for (const order of orders) {
    const available = reserve.filter((u) => reachable(u, order.goal.point));
    const center = available.length ? rendezvous(available, true) : o.home;
    const sorted = [...available].sort(
      (a, b) =>
        distance2(a, center) - distance2(b, center) ||
        a.name.localeCompare(b.name) ||
        a.x - b.x ||
        a.y - b.y ||
        a.hp - b.hp,
    );
    const amounts = [
      ...new Set([
        0,
        1,
        Math.ceil(available.length / 3),
        Math.ceil((2 * available.length) / 3),
        available.length,
      ]),
    ].filter((n) => n <= available.length);
    const target = snapshot.targets.length;
    snapshot.targets.push(order.goal);
    for (const n of amounts) {
      if (isLocalManeuver(order) && n) continue;
      if ((!commandMembers && !n) || (sameOrder(order, commandCurrent) && !n))
        continue;
      if (!n && !commandForce.some((u) => reachable(u, order.goal.point)))
        continue;
      const added = n ? selectLaunchMembers(sorted, n) : [];
      snapshot.actions.push({
        kind: "apply",
        order: sameOrder(order, commandCurrent) ? undefined : order,
        addRefs: added.map((u) => u.ref),
        units: added.map((u) => u.ref),
        expectedStateVersion: s.stateVersion,
        target,
        amount: n,
      });
      snapshot.candidates.push(encode(order, added));
    }
  }
  for (const order of localOrders) {
    if (
      scope !== "operation" ||
      !commandMembers ||
      orders.some(
        (existing) =>
          existing.kind === order.kind &&
          pointKey(existing.goal.point) === pointKey(order.goal.point),
      )
    )
      continue;
    if (!isLocalManeuver(order) || order.kind !== "withdraw")
      throw new Error("Invalid local maneuver");
    if (!commandForce.some((u) => reachable(u, order.goal.point))) continue;
    const target = snapshot.targets.length;
    snapshot.targets.push(order.goal);
    snapshot.actions.push({
      kind: "apply",
      order,
      addRefs: [],
      units: [],
      expectedStateVersion: s.stateVersion,
      target,
      amount: 0,
    });
    snapshot.candidates.push(encode(order, []));
  }
  if (
    snapshot.actions.length >
      (localOrders.length || isLocalManeuver(current)
        ? LOCAL_MAX_ACTIONS
        : OPERATION_MAX_ACTIONS) ||
    snapshot.global.length !== OPERATION_GLOBAL_SIZE ||
    snapshot.candidates.some(
      (f) => f.length !== OPERATION_CANDIDATE_SIZE || !f.every(Number.isFinite),
    )
  )
    throw new Error("Invalid operation encoding");
  return snapshot;
}

/** BC accepts a semantically exact rule action, never a nearby target or fake KEEP. */
export function matchTeacher(c: OperationContext, snapshot: OperationSnapshot) {
  const before = authorizedArmor(c.state),
    after = authorizedArmor(c.advice.state),
    desired = c.advice.state.order;
  if ([...before].some((ref) => !after.has(ref)))
    return {
      action: -1,
      reason: c.advice.recalled.length
        ? "partial-recall-or-release"
        : "released-members",
    };
  if (
    snapshot.scope === "operation" &&
    c.advice.state.withdrawing.size &&
    (c.advice.state.assault.size || c.advice.state.joining.size)
  )
    return { action: -1, reason: "multiple-purposes" };
  for (let i = 0; i < snapshot.actions.length; i++) {
    const a = snapshot.actions[i],
      resulting = new Set([...before, ...a.addRefs]);
    if (
      sameSet(resulting, after) &&
      samePurpose(a.order ?? c.state.order, desired)
    )
      return { action: i, reason: "exact" };
  }
  return { action: -1, reason: "outside-menu" };
}

export class ExperimentalOperationProvider implements OperationProvider {
  readonly period = 75;
  readonly teacher: boolean;
  readonly executionSource: "policy" | "teacher";
  record?: OperationRecord;
  private readonly history: number[][] = [];
  private readonly random: () => number;
  private readonly maneuvers = new LocalManeuvers();
  constructor(
    readonly scope: OperationScope,
    readonly policyName: string,
    seed: string,
    private readonly policy?: LaunchPolicy,
    private readonly deterministic = false,
    readonly contactInput?: ContactInput,
    readonly maneuverScope?: ManeuverScope,
  ) {
    if (!["launch", "operation"].includes(scope))
      throw new Error("Unsupported operation scope");
    if (
      maneuverScope &&
      (scope !== "operation" ||
        !contactInput ||
        !["base", "local"].includes(maneuverScope))
    )
      throw new Error(
        "Local maneuver experiment needs contact inputs and persistent control",
      );
    this.teacher = policyName === "teacher";
    if (policyName === "teacher-menu" && scope !== "operation")
      throw new Error("Menu teacher v1 requires persistent-operation scope");
    this.executionSource = ["teacher", "teacher-menu"].includes(policyName)
      ? "teacher"
      : "policy";
    this.random = seedrandom(seed);
  }
  get schema() {
    return this.maneuverScope
      ? MANEUVER_SCHEMA
      : this.contactInput
        ? CONTACT_SCHEMA
        : OPERATION_SCHEMA;
  }
  choose(c: OperationContext): OperationAction {
    if (c.observation.tick % this.period)
      throw new Error("Operation decision outside strategy clock");
    const s = buildOperationSnapshot(
        c,
        this.scope,
        this.maneuverScope === "local" ? this.maneuvers.observe(c) : [],
      ),
      teacher =
        this.policyName === "teacher-menu"
          ? chooseMenuTeacher(c, s)
          : matchTeacher(c, s);
    this.history.push(
      s.global.slice(OPERATION_STEP_SIZE * 3, OPERATION_STEP_SIZE * 4),
    );
    if (this.history.length > 4) this.history.shift();
    s.global = [
      ...Array((4 - this.history.length) * OPERATION_STEP_SIZE).fill(0),
      ...this.history.flat(),
      ...Array(4 - this.history.length).fill(0),
      ...Array(this.history.length).fill(1),
    ];
    if (this.contactInput)
      s.global.push(
        ...(this.contactInput === "local"
          ? operationContactFacts(c)
          : Array(CONTACT_SIZE).fill(0)),
      );
    if (this.maneuverScope)
      s.candidates = s.candidates.map((features, i) => [
        ...features,
        ...destinationContactFacts(c, s.actions[i].order ?? c.state.order),
      ]);
    let action = this.executionSource === "teacher" ? teacher.action : 0,
      logp = 0,
      value = 0;
    if (this.policyName === "random") {
      action = Math.floor(this.random() * s.actions.length);
      logp = -Math.log(s.actions.length);
    }
    if (this.policy) {
      const prediction = this.policy.predict(s);
      value = prediction.value;
      if (prediction.probabilities.length !== s.actions.length)
        throw new Error("Operation probability/action mismatch");
      if (this.deterministic)
        action = prediction.probabilities.indexOf(
          Math.max(...prediction.probabilities),
        );
      else {
        let r = this.random();
        action = s.actions.length - 1;
        for (let i = 0; i < s.actions.length; i++) {
          r -= prediction.probabilities[i];
          if (r <= 0) {
            action = i;
            break;
          }
        }
      }
      logp = Math.log(Math.max(1e-30, prediction.probabilities[action]));
    }
    this.record = {
      ...s,
      schema: this.schema,
      ...(this.contactInput ? { contactInput: this.contactInput } : {}),
      ...(this.maneuverScope ? { maneuverScope: this.maneuverScope } : {}),
      action,
      teacherAction: teacher.action,
      teacherCoverage: teacher.reason,
      logp,
      value,
      trainable: s.actions.length > 1,
      policy: this.policyName,
      executionSource: this.executionSource,
      delegatedChange: c.delegatedChange,
    };
    return s.actions[action < 0 ? 0 : action]; // Unrepresentable teachers execute the separately recorded raw rule advice.
  }
}
