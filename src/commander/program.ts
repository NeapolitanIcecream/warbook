import { distance2, type Observation } from "../model.js";
import {
  TaskRevision,
  type CombatMission,
  type ProgramProductionPlan,
  type StrategicPlan,
} from "../control/contracts.js";
import { committedStock } from "../control/program-production.js";
import {
  AMOUNTS,
  CASH_FLOORS,
  DEPLOY,
  KEEP_UNIT,
  RESERVE,
  UNASSIGNED,
  TASK_KINDS,
  TASK_SLOTS,
  goalMask,
  initialProgram,
  keepAction,
  type CommanderAction,
  type CommanderWorld,
  type Goal,
  type ProgramState,
} from "./world.js";
import { commanderRoleMask, type CommanderEncoding } from "./action-mask.js";

const sameGoal = (a?: Goal, b?: Goal) =>
  !!a === !!b &&
  (!a ||
    (!!b &&
      a.x === b.x &&
      a.y === b.y &&
      !!a.onBridge === !!b.onBridge &&
      a.ref === b.ref &&
      (a.kind === "native") === (b.kind === "native")));
export class ProgramController {
  constructor(readonly encoding: CommanderEncoding = "graph-plan-v2") {}
  private roleMask(w: CommanderWorld, i: number, kinds: readonly number[]) {
    return commanderRoleMask(w, i, kinds, this.encoding);
  }
  readonly state: ProgramState = initialProgram();
  private teacherSlots = new Map<string, number>();
  private revisions = Array.from(
    { length: TASK_SLOTS + 2 },
    () => new TaskRevision(),
  );
  private productionRevision = new TaskRevision();
  projectionDistances: number[] = [];

  teacherAction(
    o: Observation,
    w: CommanderWorld,
    desired: StrategicPlan<ProgramProductionPlan>,
  ): CommanderAction {
    const a = keepAction(w);
    this.projectionDistances = [];
    const missions = [desired.combat, ...(desired.additionalCombat ?? [])];
    if (missions.length > TASK_SLOTS)
      throw new Error(`Teacher needs ${missions.length} task slots`);
    const wantedIds = new Set(missions.map((m) => m.id));
    for (const id of this.teacherSlots.keys())
      if (!wantedIds.has(id)) this.teacherSlots.delete(id);
    for (const m of missions)
      if (!this.teacherSlots.has(m.id)) {
        const used = new Set(this.teacherSlots.values());
        const slot = Array.from({ length: TASK_SLOTS }, (_, i) => i).find(
          (i) => !used.has(i),
        )!;
        this.teacherSlots.set(m.id, slot);
      }
    const slots = new Set(this.teacherSlots.values());
    for (let i = 0; i < TASK_SLOTS; i++)
      if (!slots.has(i) && this.state.slots[i].active) a.kinds[i] = 1;
    const roles = new Map<string, number>();
    for (const m of missions) {
      const i = this.teacherSlots.get(m.id)!,
        old = this.state.slots[i];
      let kind = TASK_KINDS.indexOf(m.kind);
      // Legacy capture-without-target explicitly sends the engineer home.
      // Encode that movement, rather than trying to capture an unrelated visible object.
      if (m.kind === "capture" && !m.target)
        kind = TASK_KINDS.indexOf("withdraw");
      if (!m.destination && m.kind !== "harvest") kind = 10;
      let mask = goalMask(w, kind);
      if (kind !== 10 && !mask.some(Boolean)) kind = 10;
      mask = goalMask(w, kind);
      const candidates = w.goalObjects
        .map((g, j) => ({ g, j }))
        .filter(({ g, j }) => mask[j] && (m.target ? true : !g.ref));
      let goal = candidates.find(({ g }) => m.target && g.ref === m.target);
      if (!goal && m.destination)
        goal = candidates.sort(
          (a, b) =>
            Number(!!a.g.onBridge !== !!m.destination!.onBridge) -
              Number(!!b.g.onBridge !== !!m.destination!.onBridge) ||
            distance2(a.g, m.destination!) - distance2(b.g, m.destination!),
        )[0];
      goal ??= candidates[0] ?? { g: w.goalObjects[0], j: 0 };
      if (m.destination)
        this.projectionDistances.push(
          Math.sqrt(distance2(goal.g, m.destination)),
        );
      const focus = kind !== 10 && m.objective === "exposed-construction";
      const crush = kind !== 10 && m.engagement.allowCrush,
        interrupt = kind !== 10 && !!m.engagement.interrupt;
      if (
        !old.active ||
        old.kind !== TASK_KINDS[kind] ||
        !sameGoal(old.goal, kind === 10 ? undefined : goal.g) ||
        old.allowCrush !== crush ||
        old.interrupt !== interrupt ||
        !!old.focus !== focus
      ) {
        a.kinds[i] = kind;
        a.goals[i] = kind === 10 ? w.previousGoals[i] : goal.j;
        a.engagement[i] =
          Number(crush) + 2 * Number(interrupt) + 4 * Number(focus);
      }
      for (const ref of m.units) {
        if (roles.has(ref)) throw new Error("Teacher has duplicate ownership");
        roles.set(ref, i);
      }
    }
    for (const ref of desired.production.deploymentUnits) {
      if (roles.has(ref)) throw new Error("Teacher deploy/mission conflict");
      roles.set(ref, DEPLOY);
    }
    w.unitRefs.forEach((ref, i) => {
      const role = roles.get(ref) ?? UNASSIGNED;
      a.units[i] =
        role === w.previousRoles[i] && this.roleMask(w, i, a.kinds)[KEEP_UNIT]
          ? KEEP_UNIT
          : role;
      if (!this.roleMask(w, i, a.kinds)[a.units[i]])
        throw new Error(`Unsupported teacher assignment ${ref}/${role}`);
    });
    for (const desiredQueue of desired.production.program.queues) {
      const q = desiredQueue.queue,
        old = this.state.production.program.queues.find((x) => x.queue === q)!;
      if (desiredQueue.mode === "pause")
        a.queues[q] = old.mode === "pause" ? 0 : 2;
      else if (desiredQueue.mode === "cancel") a.queues[q] = 3;
      else if (!desiredQueue.product || desiredQueue.target === 0)
        a.queues[q] = old.target === 0 && old.mode === "run" ? 0 : 1;
      else {
        const product = w.productNames.indexOf(desiredQueue.product);
        if (product < 0)
          throw new Error("Teacher product absent from catalogue");
        a.queues[q] = product + 4;
        const delta =
          desiredQueue.target < 0
            ? -1
            : Math.max(
                1,
                desiredQueue.target - committedStock(o, desiredQueue.product),
              );
        a.amounts[q] = AMOUNTS.indexOf(delta as any);
        if (a.amounts[q] < 0)
          throw new Error("Teacher quantity outside program vocabulary");
        a.cash[q] = CASH_FLOORS.indexOf(desiredQueue.reserve as any);
        if (a.cash[q] < 0)
          throw new Error("Teacher cash floor outside program vocabulary");
      }
    }
    w.buildingRefs.forEach((ref, i) => {
      const own = o.own.find((u) => u.ref === ref)!;
      const repair = desired.production.program.repair.includes(ref);
      a.buildings[i] = desired.production.program.sell.includes(ref)
        ? 3
        : repair !== this.state.production.program.repair.includes(ref)
          ? repair
            ? 1
            : 2
          : 0;
    });
    for (const site of desired.production.program.placements) {
      const i = w.placementObjects.findIndex(
        (p) => p.name === site.name && p.x === site.x && p.y === site.y,
      );
      if (i < 0)
        throw new Error("Teacher placement outside observed legal choices");
      a.placements[w.placementObjects[i].queue] = i + 1;
    }
    return a;
  }
  apply(o: Observation, w: CommanderWorld, a: CommanderAction) {
    if (
      a.kinds.length !== TASK_SLOTS ||
      a.units.length !== w.unitRefs.length ||
      a.queues.length !== 6 ||
      a.buildings.length !== w.buildingRefs.length
    )
      throw new Error("Malformed commander action");
    for (let i = 0; i < TASK_SLOTS; i++) {
      const k = a.kinds[i];
      if (!Number.isInteger(k) || k < 0 || k >= TASK_KINDS.length)
        throw new Error("Invalid task kind");
      if (!k) continue;
      if (
        this.encoding === "graph-plan-v2" &&
        (!this.state.slots[i].active ||
          this.state.slots[i].kind !== TASK_KINDS[k])
      ) {
        // Docked/transported units have no action row this step. Do not silently
        // enroll them in a new job when they return; retain their native command.
        const visible = new Set(w.unitRefs);
        for (const [ref, role] of this.state.roles)
          if (role === i && !visible.has(ref)) this.state.roles.delete(ref);
      }
      if (k === 1) {
        this.state.slots[i].active = false;
        continue;
      }
      if (k !== 10 && !goalMask(w, k)[a.goals[i]])
        throw new Error("Invalid task goal");
      const mode = a.engagement[i];
      if (!Number.isInteger(mode) || mode < 0 || mode > 7)
        throw new Error("Invalid engagement");
      this.state.slots[i] = {
        active: true,
        kind: TASK_KINDS[k] as CombatMission["kind"],
        goal: k === 10 ? undefined : { ...w.goalObjects[a.goals[i]] },
        allowCrush: !!(mode & 1),
        interrupt: !!(mode & 2),
        focus: !!(mode & 4),
        since: o.tick,
      };
    }
    for (const ref of o.ownDepartures ?? []) this.state.roles.delete(ref);
    w.unitRefs.forEach((ref, i) => {
      if (!this.roleMask(w, i, a.kinds)[a.units[i]])
        throw new Error("Invalid unit role");
      const role = a.units[i] === KEEP_UNIT ? w.previousRoles[i] : a.units[i];
      if (role === UNASSIGNED) this.state.roles.delete(ref);
      else this.state.roles.set(ref, role);
    });
    for (const [ref, role] of this.state.roles)
      if (role < TASK_SLOTS && !this.state.slots[role].active)
        this.state.roles.set(ref, RESERVE);
    const queues = [...this.state.production.program.queues].map((p) => ({
      ...p,
    }));
    for (let q = 0; q < 6; q++) {
      const choice = a.queues[q];
      if (
        !Number.isInteger(choice) ||
        choice < 0 ||
        choice >= w.productNames.length + 4
      )
        throw new Error("Invalid product choice");
      if (choice === 0) continue;
      if (choice === 1) {
        queues[q] = { queue: q, mode: "run", target: 0, reserve: 0 };
        continue;
      }
      if (choice < 4) {
        queues[q] = { ...queues[q], mode: choice === 2 ? "pause" : "cancel" };
        continue;
      }
      const p = choice - 4;
      if (w.productQueues[p] !== q) throw new Error("Product queue mismatch");
      const amount = AMOUNTS[a.amounts[q]],
        reserve = CASH_FLOORS[a.cash[q]];
      if (amount === undefined || reserve === undefined)
        throw new Error("Invalid quantity/cash floor");
      queues[q] = {
        queue: q,
        mode: "run",
        product: w.productNames[p],
        target: amount < 0 ? -1 : committedStock(o, w.productNames[p]) + amount,
        reserve,
      };
    }
    const repair = new Set(
      this.state.production.program.repair.filter((ref) =>
        o.own.some((u) => u.ref === ref),
      ),
    );
    const sell: string[] = [];
    w.buildingRefs.forEach((ref, i) => {
      const c = a.buildings[i],
        cap = w.buildingCapabilities[i];
      if (
        !Number.isInteger(c) ||
        c < 0 ||
        c > 3 ||
        (c === 3 && !cap.sell) ||
        ((c === 1 || c === 2) && !cap.repair)
      )
        throw new Error("Invalid building command");
      if (c === 1) repair.add(ref);
      if (c === 2) repair.delete(ref);
      if (c === 3) {
        sell.push(ref);
        repair.delete(ref);
      }
    });
    const placements = a.placements.flatMap((choice, q) => {
      if (choice === 0) return [];
      const p = w.placementObjects[choice - 1];
      if (!p || p.queue !== q) throw new Error("Invalid placement");
      return [{ name: p.name, x: p.x, y: p.y }];
    });
    this.state.production = {
      id: "commander-production",
      revision: 0,
      deploymentUnits: [],
      program: { queues, placements, repair: [...repair], sell },
    };
  }
  plan(o: Observation): StrategicPlan<ProgramProductionPlan> {
    const live = new Set(o.own.map((u) => u.ref));
    const units = (role: number) =>
      [...this.state.roles]
        .filter(([ref, r]) => live.has(ref) && r === role)
        .map(([ref]) => ref);
    const missions: CombatMission[] = this.state.slots.map((s, i) => {
      const target =
        s.goal?.ref &&
        [
          ...o.own,
          ...o.enemies,
          ...(o.capturableBuildings ?? o.techBuildings ?? []),
        ].find((u) => u.ref === s.goal!.ref);
      const selected =
        s.goal?.kind === "native"
          ? undefined
          : target
            ? { ...s.goal!, x: target.x, y: target.y }
            : s.goal;
      // Goal carries semantic `kind`; do not spread it into a native Intent.
      const goal = selected
        ? {
            x: selected.x,
            y: selected.y,
            ...(selected.onBridge ? { onBridge: true } : {}),
          }
        : undefined;
      const description = {
        kind: s.active ? s.kind : ("hold" as const),
        units: units(i),
        destination: goal,
        groundDestination: goal,
        approach: s.kind === "harvest" || s.kind === "hold" ? undefined : goal,
        target: s.goal?.ref,
        objective: s.focus ? "exposed-construction" : `commander-${s.kind}`,
        protectedAssets: goal
          ? o.own
              .filter(
                (u) =>
                  (u.type === 2 || u.harvester) &&
                  distance2(u, goal) <= 12 ** 2,
              )
              .map((u) => u.ref)
          : [],
        engagement: { allowCrush: s.allowCrush, interrupt: s.interrupt },
      };
      return {
        id: `commander-task-${i}`,
        revision: this.revisions[i].update(description),
        ...description,
      };
    });
    const held = units(RESERVE),
      unassigned = o.own
        .filter((u) => (u.type !== 2 || u.yard) && !this.state.roles.has(u.ref))
        .map((u) => u.ref);
    const reserve: CombatMission = {
      id: "commander-reserve",
      revision: this.revisions[TASK_SLOTS].update(held),
      kind: "hold",
      units: held,
      objective: "explicit-hold",
      engagement: { allowCrush: false },
    };
    const native: CombatMission = {
      id: "commander-unassigned",
      revision: this.revisions[TASK_SLOTS + 1].update(unassigned),
      kind: "hold",
      units: unassigned,
      objective: "preserve-native",
      engagement: { allowCrush: false },
    };
    const production = {
      ...this.state.production,
      deploymentUnits: units(DEPLOY),
    };
    production.revision = this.productionRevision.update({
      program: production.program,
      deploymentUnits: production.deploymentUnits,
    });
    return {
      tick: o.tick,
      combat: missions[0],
      additionalCombat: [...missions.slice(1), reserve, native],
      production,
    };
  }
}
