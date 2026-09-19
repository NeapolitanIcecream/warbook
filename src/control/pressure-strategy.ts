import {
  distance2,
  type Contact,
  type Observation,
  type Unit,
} from "../model.js";
import { isScout } from "./reconnaissance.js";
import { BastionStrategy } from "./bastion-strategy.js";
import {
  TaskRevision,
  type CombatMission,
  type ControlReport,
  type StrategicController,
  type TacticalAssessment,
} from "./contracts.js";

/** Independent pressure route: two infantry groups attack separate economic targets. */
export class PressureStrategy implements StrategicController {
  readonly id = "two-front-pressure-v4";
  private readonly base = new BastionStrategy("cohort");
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
    // The first wave needs both fronts ready. Replacements are whole cohorts;
    // a casualty at the front must not send one new recruit across the map alone.
    let spare = Math.max(0, idle.length - 2);
    if (this.groups.some((g) => g.size) || spare >= 6)
      for (const group of this.groups) {
        if (group.size || spare < 3) continue;
        for (let i = 0; i < 3; i++) group.add(idle.shift()!.ref);
        spare -= 3;
      }
    const allocated = raiders();
    const reconRefs = new Set(
      (plan.additionalCombat ?? [])
        .filter((m) => m.kind === "scout")
        .flatMap((m) => m.units),
    );
    const dogs = o.own
      .filter((u) => isScout(u) && !reconRefs.has(u.ref))
      .sort((a, b) => a.ref.localeCompare(b.ref))
      .slice(0, 2);
    for (let i = 0; i < 2; i++)
      if (this.groups[i].size && dogs[i]) allocated.add(dogs[i].ref);
    const structures = [...this.known.values()].filter(
      (e) => !(e.weaponRange ?? 0),
    );
    const exposed = (target: Contact) =>
      o.enemies.filter(
        (e) => (e.weaponRange ?? 0) > 0 && distance2(e, target) <= 10 ** 2,
      ).length;
    structures.sort(
      (a, b) =>
        exposed(a) - exposed(b) ||
        Number(b.name.endsWith("POWR")) - Number(a.name.endsWith("POWR")) ||
        distance2(a, o.home) - distance2(b, o.home),
    );
    const raidingWindow =
      structures.some(
        (e) => exposed(e) === 0 && o.enemies.some((v) => v.ref === e.ref),
      ) || plan.combat.kind === "advance";
    if (!raidingWindow) {
      for (const group of this.groups) group.clear();
      allocated.clear();
    }
    const first = structures[0];
    const second = first
      ? [...structures]
          .filter((e) => e.ref !== first.ref)
          .sort(
            (a, b) =>
              exposed(a) - exposed(b) ||
              distance2(b, first) - distance2(a, first),
          )[0]
      : undefined;
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
      const armorFront =
        target && exposed(target) > 0 && plan.combat.kind === "advance"
          ? o.own
              .filter((u) => plan.combat.units.includes(u.ref) && u.type === 7)
              .sort((a, b) => distance2(a, target) - distance2(b, target))[0]
          : undefined;
      const goal = armorFront ?? target ?? starts[i % starts.length];
      const destination = goal ? { x: goal.x, y: goal.y } : undefined;
      if (dogs[i] && destination) {
        const front = gi
          .filter((u) => group.has(u.ref))
          .sort(
            (a, b) => distance2(a, destination) - distance2(b, destination),
          )[0];
        if (front)
          additionalCombat.push(
            this.revise({
              id: `pressure-screen-${i}`,
              revision: 0,
              kind: "screen",
              units: [dogs[i].ref],
              destination: {
                x: front.x,
                y: front.y,
                ...(front.onBridge === undefined
                  ? {}
                  : { onBridge: front.onBridge }),
              },
              objective: "protect-infantry-approach",
              engagement: { allowCrush: false },
            }),
          );
      }
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
      defenses: production.defenses?.map((g) => ({
        ...g,
        count: this.groups.some((group) => group.size)
          ? Math.max(1, g.count)
          : g.count,
      })),
      infantry: { ...production.infantry, count: raidingWindow ? 10 : 6 },
      scouts: {
        product: o.side === 0 ? "ADOG" : "DOG",
        count:
          (o.starts.length > 2 ? 2 : 1) +
          (assessment.observedArmor >= 4 ? 2 : 0),
        required: o.starts.length > 2 ? 2 : 1,
      },
      structures: [
        ...production.structures,
        {
          product: o.side === 0 ? "GAPILE" : "NAHAND",
          count:
            assessment.observedArmor >= 6 &&
            raidingWindow &&
            o.credits >= 2500 &&
            gi.length >= 8
              ? 2
              : 1,
        },
      ],
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
