import {
  distance2,
  type Contact,
  type Observation,
  type Unit,
} from "../model.js";
import { BastionStrategy } from "./bastion-strategy.js";
import { Operations } from "./operations.js";
import {
  TaskRevision,
  type CombatMission,
  type ControlReport,
  type StrategicController,
  type TacticalAssessment,
} from "./contracts.js";

/** Independent pressure route: two infantry groups attack separate economic targets. */
export class PressureStrategy implements StrategicController {
  readonly id = "two-front-pressure-v2";
  // Pressure accepts a near-parity engagement; the defender keeps its larger
  // margin. Both still assess legal enemy contacts, reinforcements and health.
  private readonly base = new BastionStrategy("cohort", new Operations(1, 0.9));
  private readonly revisions = new Map<string, TaskRevision>();
  private readonly productionRevision = new TaskRevision();
  private readonly groups = [new Set<string>(), new Set<string>()];
  private readonly known = new Map<string, Contact>();

  assessmentRequest(o: Observation) {
    return this.base.assessmentRequest(o);
  }

  private revise(m: CombatMission): CombatMission {
    let revision = this.revisions.get(m.id);
    if (!revision) this.revisions.set(m.id, (revision = new TaskRevision()));
    const { revision: _old, ...description } = m;
    return {
      ...m,
      revision: revision.update({ ...description, units: [...m.units].sort() }),
    };
  }

  plan(
    o: Observation,
    assessment: TacticalAssessment,
    feedback?: ControlReport,
  ) {
    const plan = this.base.plan(o, assessment, feedback);
    const gi = o.own.filter((u) => u.name === (o.side === 0 ? "E1" : "E2"));
    const alive = new Set(gi.map((u) => u.ref));
    for (const group of this.groups)
      for (const ref of group) if (!alive.has(ref)) group.delete(ref);
    for (const e of o.enemies.filter((e) => e.type === 2))
      this.known.set(e.ref, e);
    for (const [ref, e] of this.known)
      if (
        !o.enemies.some((v) => v.ref === ref) &&
        o.own.some((u) => distance2(u, e) <= 5 ** 2)
      )
        this.known.delete(ref);
    const raiders = () => new Set(this.groups.flatMap((g) => [...g]));
    const engaged = (u: Unit) =>
      o.enemies.some((e) => distance2(u, e) <= 6 ** 2);
    const idle = gi.filter((u) => !raiders().has(u.ref) && !engaged(u));
    // Leave two defenders and launch complete three-person groups, not a stream of singles.
    let spare = Math.max(0, idle.length - 2);
    for (const group of this.groups) {
      const needed = 3 - group.size;
      if (needed <= 0 || spare < needed) continue;
      for (let i = 0; i < needed; i++) group.add(idle.shift()!.ref);
      spare -= needed;
    }
    const allocated = raiders();
    const structures = [...this.known.values()].filter(
      (e) => !(e.weaponRange ?? 0),
    );
    structures.sort(
      (a, b) =>
        Number(b.name.endsWith("POWR")) - Number(a.name.endsWith("POWR")) ||
        distance2(a, o.home) - distance2(b, o.home),
    );
    const first = structures[0];
    const miners = o.enemies.filter(
      (e) =>
        ["CMIN", "HARV"].includes(e.name) &&
        (!first || distance2(e, first) >= 8 ** 2),
    );
    const secondGroup = gi.filter((u) => this.groups[1].has(u.ref));
    miners.sort(
      (a, b) =>
        Math.min(...secondGroup.map((u) => distance2(a, u)), Infinity) -
        Math.min(...secondGroup.map((u) => distance2(b, u)), Infinity),
    );
    const second =
      miners[0] ??
      (first
        ? [...structures]
            .filter((e) => e.ref !== first.ref)
            .sort((a, b) => distance2(b, first) - distance2(a, first))[0]
        : undefined);
    const starts = o.starts.filter((p) => distance2(p, o.home) > 12 ** 2);
    const additionalCombat = (plan.additionalCombat ?? []).map((m) =>
      this.revise({
        ...m,
        units: m.units.filter((ref) => !allocated.has(ref)),
      }),
    );
    this.groups.forEach((group, i) => {
      if (!group.size) return;
      const target = i ? (second ?? first) : first;
      const goal = target ?? starts[i % starts.length];
      const destination = goal ? { x: goal.x, y: goal.y } : undefined;
      additionalCombat.push(
        this.revise({
          id: `pressure-${i}`,
          revision: 0,
          kind: "advance",
          units: [...group],
          destination,
          objective: "pressure-separate-economic-targets",
          ...(target && o.enemies.some((e) => e.ref === target.ref)
            ? { target: target.ref }
            : {}),
          engagement: { allowCrush: false },
        }),
      );
    });
    const { revision: _old, ...production } = plan.production;
    const updated = {
      ...production,
      infantry: { ...production.infantry, count: 10 },
      // The route depends on replacing raiders after the opening. The base's
      // 800-credit infantry gate lets continuous armor production starve them.
      spending: { ...production.spending, infantryAbove: 250 },
    };
    return {
      ...plan,
      combat: this.revise({
        ...plan.combat,
        units: plan.combat.units.filter((ref) => !allocated.has(ref)),
      }),
      additionalCombat,
      production: {
        ...updated,
        revision: this.productionRevision.update(updated),
      },
    };
  }
}
