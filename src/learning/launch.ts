import seedrandom from "seedrandom";
import {
  distance2,
  type Contact,
  type Observation,
  type Point,
  type Unit,
} from "../model.js";
import {
  LegacyLaunchProvider,
  type LegacyLaunchContext,
  type LaunchProposal,
  type LaunchProvider,
} from "../control/launch-provider.js";
import { rendezvous } from "../control/formation.js";

export const LAUNCH_SCHEMA = "launch-v1";
export const BASE_GLOBAL_SIZE = 28;
export const GLOBAL_SIZE = BASE_GLOBAL_SIZE * 4 + 4;
export const CANDIDATE_SIZE = 32;
export interface LaunchAction {
  target?: number;
  amount?: number;
  units: string[];
}
export interface LaunchSnapshot {
  tick: number;
  global: number[];
  candidates: number[][];
  actions: LaunchAction[];
  targets: { key: string; point: Point; ref?: string; kind: string }[];
  sourceTargets: number;
  omittedTargets: number;
}
export interface LaunchPrediction {
  probabilities: number[];
  value: number;
}
export interface LaunchPolicy {
  predict(snapshot: LaunchSnapshot): LaunchPrediction;
}
export interface LaunchRecord extends LaunchSnapshot {
  schema: string;
  action: number;
  logp: number;
  value: number;
  trainable: boolean;
  teacherAction: number;
  policy: string;
  teacherProjection?: {
    requestedCount: number;
    actualCount: number;
    targetDistance: number;
  };
}
export const isArmor = (u: { name: string }) =>
  ["MTNK", "HTNK", "SREF"].includes(u.name);
const pkey = (p: Point) => `${p.x}:${p.y}:${Boolean(p.onBridge)}`;
export const norm = (x: number, n: number) => Math.max(-4, Math.min(4, x / n));
export const mean = (xs: readonly number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
export const hp = (u: { hp: number; maxHp: number }) =>
  u.hp / Math.max(1, u.maxHp);
export const count = (
  xs: readonly { type: number; name: string }[],
  names: string[],
) => xs.filter((x) => names.includes(x.name)).length;
export const near = (p: Point, q: Point) => distance2(p, q) <= 12 ** 2;

export function globalFeatures(
  o: Observation,
  pool: readonly Unit[],
  known: readonly Contact[],
): number[] {
  const army = o.own.filter(isArmor),
    enemies = o.enemies;
  return [
    o.tick / 54000,
    Math.max(0, 1 - o.tick / 54000),
    norm(Math.log1p(o.credits), 10),
    norm(o.power.total - o.power.drain, 500),
    Number(o.power.isLowPower),
    norm(army.length, 24),
    mean(army.map(hp)),
    norm(pool.length, 24),
    mean(pool.map(hp)),
    norm(o.own.filter((u) => u.type === 3 && u.combat).length, 24),
    norm(o.own.filter((u) => u.harvester).length, 6),
    norm(o.own.filter((u) => u.type === 2).length, 12),
    norm(count(enemies, ["MTNK", "HTNK", "SREF"]), 24),
    norm(enemies.filter((u) => u.type === 3).length, 24),
    norm(enemies.filter((u) => u.type === 2).length, 12),
    norm(known.filter((u) => u.type === 2).length, 12),
    norm(o.own.filter((u) => u.name === "SREF").length, 6),
    norm(
      o.queues.reduce((n, q) => n + q.size, 0),
      10,
    ),
    norm(o.own.filter((u) => u.name.endsWith("WEAP")).length, 3),
    norm(o.own.filter((u) => u.refinery).length, 3),
    norm(
      enemies.filter((e) =>
        o.own.some(
          (u) => (u.type === 2 || u.harvester) && distance2(u, e) <= 10 ** 2,
        ),
      ).length,
      12,
    ),
    norm(
      (o.oreFields ?? []).reduce((n, p) => n + p.amount, 0),
      4000,
    ),
    norm(o.armySearchPoints?.length ?? 0, 100),
    Number(o.own.some((u) => u.name === "GATECH")),
    norm(army.filter((u) => (u.attackState ?? 0) >= 3).length, 24),
    norm(mean(army.map((u) => Math.sqrt(distance2(u, o.home)))), 128),
    Number(pool.length > 0),
    norm(army.length - pool.length, 24),
  ];
}

export interface CandidateTarget {
  point: Point;
  kind: string;
  contact?: Contact;
}

export function selectLaunchMembers(
  sorted: readonly Unit[],
  n: number,
): Unit[] {
  // Keep the observed composition approximately proportional, then fill by proximity.
  const siege = sorted
    .filter((u) => u.name === "SREF")
    .slice(
      0,
      Math.round(
        (n * sorted.filter((u) => u.name === "SREF").length) / sorted.length,
      ),
    );
  const chosen = [
    ...siege,
    ...sorted
      .filter((u) => !siege.includes(u) && u.name !== "SREF")
      .slice(0, n - siege.length),
  ];
  for (const u of sorted)
    if (chosen.length < n && !chosen.includes(u)) chosen.push(u);
  return chosen;
}

export function launchCandidateFeatures(
  o: Observation,
  known: readonly Contact[],
  t: CandidateTarget,
  available: readonly Unit[],
  chosen: readonly Unit[],
  center: Point,
  n = chosen.length,
): number[] {
  const allies = o.own.filter((u) => near(u, t.point)),
    foes = o.enemies.filter((e) => near(e, t.point));
  const target = t.contact,
    visible = !!target && o.enemies.some((e) => e.ref === target.ref);
  const f = [
    Number(t.kind === "search"),
    Number(t.kind.endsWith("CNST") || t.kind.endsWith("MCV")),
    Number(t.kind.endsWith("WEAP")),
    Number(t.kind.endsWith("REFN")),
    Number(t.kind.endsWith("POWR")),
    norm(t.point.x - o.home.x, 128),
    norm(t.point.y - o.home.y, 128),
    norm(Math.sqrt(distance2(t.point, center)), 128),
    Number(!!target),
    target ? hp(target) : 0,
    Number(visible),
    target ? norm(o.tick - target.observedTick, 54000) : 0,
    norm(count(foes, ["MTNK", "HTNK", "SREF"]), 16),
    norm(foes.filter((e) => e.type === 3).length, 16),
    norm(
      foes.filter((e) => e.type === 2 && (e.weaponRange ?? 0) > 0).length,
      8,
    ),
    mean(foes.filter((e) => e.type === 7).map(hp)),
    norm(allies.filter(isArmor).length, 16),
    norm(allies.filter((u) => u.type === 3).length, 16),
    norm(n, 24),
    n / available.length,
    mean(chosen.map(hp)),
    Math.min(...chosen.map(hp)),
    norm(chosen.filter((u) => u.name === "SREF").length, 6),
    norm(mean(chosen.map((u) => Math.sqrt(distance2(u, center)))), 32),
    Number(!!t.point.onBridge),
    norm(
      known.filter(
        (e) => near(e, t.point) && !o.enemies.some((v) => v.ref === e.ref),
      ).length,
      16,
    ),
    norm(allies.filter((u) => u.harvester).length, 6),
    norm(foes.filter((e) => e.deployed).length, 16),
    norm(foes.filter((e) => e.type === 2).length, 12),
    norm(mean(chosen.map((u) => Math.sqrt(distance2(u, t.point)))), 128),
    norm(available.length - n, 24),
    1,
  ];
  return f;
}

/** All choices originate in legal facts. No legacy risk score filters this menu. */
export function buildLaunchSnapshot(c: LegacyLaunchContext): LaunchSnapshot {
  const o = c.observation,
    pool = (c.reserve ?? []).filter((u) => isArmor(u) && u.mobile);
  const known = c.operations.contacts;
  const result: LaunchSnapshot = {
    tick: o.tick,
    global: [
      ...Array(BASE_GLOBAL_SIZE * 3).fill(0),
      ...globalFeatures(o, pool, known),
      0,
      0,
      0,
      1,
    ],
    candidates: [Array(CANDIDATE_SIZE).fill(0)],
    actions: [{ units: [] }],
    targets: [],
    sourceTargets: 0,
    omittedTargets: 0,
  };
  if (!c.slotFree || !pool.length) return result;
  const regions = new Map(
    (o.launchGeometry ?? []).map((p) => [pkey(p), p.region]),
  );
  const starts = o.starts.filter(
    (p) =>
      distance2(p, o.home) > 12 ** 2 &&
      !(o.exploredStarts ?? []).some((q) => distance2(p, q) < 1),
  );
  const prioritySearch = new Set([
    ...(c.searchGoal ? [pkey(c.searchGoal)] : []),
    ...starts.map(pkey),
  ]);
  const critical = (name: string) =>
    ["GACNST", "NACNST", "AMCV", "SMCV"].includes(name);
  const raw = [
    ...known
      .filter((e) => e.type === 2 || ["AMCV", "SMCV"].includes(e.name))
      .map((e) => ({
        key: e.ref,
        point: { x: e.x, y: e.y, ...(e.onBridge ? { onBridge: true } : {}) },
        ref: e.ref,
        kind: e.name,
        contact: e,
      })),
    ...(o.armySearchPoints ?? []).map((p) => ({
      key: pkey(p),
      point: p,
      kind: "search",
      ref: undefined,
      contact: undefined as Contact | undefined,
    })),
    ...(known.some((e) => e.type === 2)
      ? []
      : starts.map((p) => ({
          key: pkey(p),
          point: p,
          kind: "search",
          ref: undefined,
          contact: undefined as Contact | undefined,
        }))),
  ];
  result.sourceTargets = raw.length;
  const groups = new Map<string, (typeof raw)[number]>();
  for (const t of raw.sort(
    (a, b) =>
      a.point.x - b.point.x ||
      a.point.y - b.point.y ||
      a.kind.localeCompare(b.kind),
  )) {
    const r = regions.get(pkey(t.point));
    if (
      !pool.some(
        (u) =>
          r === undefined ||
          regions.get(pkey(u)) === undefined ||
          regions.get(pkey(u)) === r,
      )
    )
      continue;
    const key =
      critical(t.kind) ||
      (t.kind === "search" && prioritySearch.has(pkey(t.point)))
        ? `objective:${t.kind}:${pkey(t.point)}`
        : `${Math.floor(t.point.x / 8)}:${Math.floor(t.point.y / 8)}:${Boolean(t.point.onBridge)}:${r ?? "unknown"}`;
    const old = groups.get(key);
    if (!old || (old.kind === "search" && t.kind !== "search"))
      groups.set(key, t);
  }
  const pending = [...groups.values()],
    selected: typeof raw = [];
  // Preserve known construction objectives and actual unexplored starts. A cloud
  // of remote frontier points must not evict the enemy base from the bounded menu.
  const preferred = pending.filter(
    (t) =>
      critical(t.kind) ||
      (!known.some((e) => e.type === 2) &&
        t.kind === "search" &&
        prioritySearch.has(pkey(t.point))),
  );
  for (const t of preferred.slice(0, 8)) {
    selected.push(t);
    pending.splice(pending.indexOf(t), 1);
  }
  if (!selected.length && pending.length) {
    const i = Math.max(
      0,
      pending.findIndex((t) => t.kind !== "search"),
    );
    selected.push(pending.splice(i, 1)[0]);
  }
  while (pending.length && selected.length < 8) {
    let best = 0,
      bestD = -1;
    const hasKnown = pending.some((t) => t.kind !== "search");
    for (let i = 0; i < pending.length; i++) {
      if (hasKnown && pending[i].kind === "search") continue;
      const d = Math.min(
        ...selected.map((t) => distance2(t.point, pending[i].point)),
      );
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    selected.push(pending.splice(best, 1)[0]);
  }
  result.omittedTargets = raw.length - selected.length;
  for (const t of selected) {
    const targetIndex = result.targets.length;
    result.targets.push({
      key: t.key,
      point: t.point,
      ref: t.ref,
      kind: t.kind,
    });
    const region = regions.get(pkey(t.point));
    const available = pool.filter(
      (u) =>
        region === undefined ||
        regions.get(pkey(u)) === undefined ||
        regions.get(pkey(u)) === region,
    );
    const center = rendezvous(available, true);
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
        1,
        Math.ceil(available.length / 3),
        Math.ceil((available.length * 2) / 3),
        available.length,
      ]),
    ];
    amounts.forEach((n, amountIndex) => {
      const chosen = selectLaunchMembers(sorted, n);
      const f = launchCandidateFeatures(
        o,
        known,
        t,
        available,
        chosen,
        center,
        n,
      );
      result.candidates.push(f);
      result.actions.push({
        target: targetIndex,
        amount: amountIndex,
        units: chosen.map((u) => u.ref),
      });
    });
  }
  return result;
}

export class ExperimentalLaunchProvider implements LaunchProvider {
  readonly experimental = true;
  record?: LaunchRecord;
  private readonly legacy = new LegacyLaunchProvider();
  private readonly history: number[][] = [];
  private readonly random: () => number;
  constructor(
    readonly policyName: string,
    seed: string,
    private readonly policy?: LaunchPolicy,
    private readonly deterministic = false,
  ) {
    this.random = seedrandom(seed);
  }
  choose(c: LegacyLaunchContext): LaunchProposal | undefined {
    if (c.observation.tick % 75 !== 0) return;
    const snapshot = buildLaunchSnapshot(c);
    this.history.push(
      snapshot.global.slice(BASE_GLOBAL_SIZE * 3, BASE_GLOBAL_SIZE * 4),
    );
    if (this.history.length > 4) this.history.shift();
    snapshot.global = [
      ...Array((4 - this.history.length) * BASE_GLOBAL_SIZE).fill(0),
      ...this.history.flat(),
      ...Array(4 - this.history.length).fill(0),
      ...Array(this.history.length).fill(1),
    ];
    const teacher = c.slotFree ? this.legacy.choose(c) : undefined;
    let teacherAction = 0;
    if (teacher && snapshot.actions.length > 1) {
      let best = Infinity;
      for (let i = 1; i < snapshot.actions.length; i++) {
        const a = snapshot.actions[i],
          t = snapshot.targets[a.target!];
        const d =
          distance2(t.point, teacher.operation.point) * 10 +
          Math.abs(a.units.length - teacher.units.filter(isArmor).length);
        if (d < best) {
          best = d;
          teacherAction = i;
        }
      }
    }
    let action = teacherAction,
      logp = 0,
      value = 0;
    if (this.policyName === "random" && snapshot.actions.length > 1) {
      action = Math.floor(this.random() * snapshot.actions.length);
      logp = -Math.log(snapshot.actions.length);
    }
    if (this.policy) {
      const prediction = this.policy.predict(snapshot);
      value = prediction.value;
      if (prediction.probabilities.length !== snapshot.actions.length)
        throw new Error("Launch probability/action mismatch");
      if (this.deterministic)
        action = prediction.probabilities.indexOf(
          Math.max(...prediction.probabilities),
        );
      else {
        let r = this.random();
        action = prediction.probabilities.length - 1;
        for (let i = 0; i < prediction.probabilities.length; i++) {
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
      ...snapshot,
      schema: LAUNCH_SCHEMA,
      action,
      logp,
      value,
      trainable: snapshot.actions.length > 1,
      teacherAction,
      policy: this.policyName,
      ...(teacher && teacherAction > 0
        ? {
            teacherProjection: {
              requestedCount: teacher.units.filter(isArmor).length,
              actualCount: snapshot.actions[teacherAction].units.length,
              targetDistance: Math.sqrt(
                distance2(
                  snapshot.targets[snapshot.actions[teacherAction].target!]
                    .point,
                  teacher.operation.point,
                ),
              ),
            },
          }
        : {}),
    };
    c.operations.decision = {
      operationReason:
        action === 0 ? "experimental-keep" : "experimental-launch",
      availableActions: snapshot.actions.length,
    };
    if (action === 0) return;
    const offer = snapshot.actions[action],
      target = snapshot.targets[offer.target!];
    const units = (c.reserve ?? []).filter((u) => offer.units.includes(u.ref));
    if (units.length !== offer.units.length)
      throw new Error("Stale launch members");
    return {
      origin: "experiment",
      units,
      operation: {
        ...c.operations.describe(
          c.observation,
          units,
          target.point,
          target.ref,
        ),
        objectiveKey: target.key,
        objectiveRef: target.ref,
        origin: "experiment",
      },
    };
  }
}

export interface LinearLaunchModel {
  format: "warbook-launch-linear-v1";
  schema: typeof LAUNCH_SCHEMA;
  params: {
    bias: number;
    power: number;
    threat: number;
    distance: number;
    objective: number;
    retained: number;
    spread: number;
    fog: number;
  };
}
/** A cheap, state-conditioned baseline on the same unfiltered action menu. */
export class LinearLaunchPolicy implements LaunchPolicy {
  constructor(readonly model: LinearLaunchModel) {
    if (
      model.format !== "warbook-launch-linear-v1" ||
      model.schema !== LAUNCH_SCHEMA ||
      !Object.values(model.params).every(Number.isFinite)
    )
      throw new Error("Invalid linear launch model");
  }
  predict(s: LaunchSnapshot): LaunchPrediction {
    const p = this.model.params;
    const logits = s.candidates.map((c, i) =>
      i === 0
        ? 0
        : p.bias +
          p.power * c[18] * 24 * c[20] -
          p.threat * (c[12] * 16 + 0.2 * c[13] * 16 + 0.45 * c[14] * 8) -
          p.distance * c[7] * 128 +
          p.objective * (c[1] + 0.7 * c[2] + 0.4 * c[3]) +
          p.retained * c[30] * 24 -
          p.spread * c[23] * 32 -
          p.fog * (1 - c[10]),
    );
    const max = Math.max(...logits),
      exp = logits.map((x) => Math.exp(x - max)),
      sum = exp.reduce((a, b) => a + b, 0);
    return { probabilities: exp.map((x) => x / sum), value: 0.5 };
  }
}
