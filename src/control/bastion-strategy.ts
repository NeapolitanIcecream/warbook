import {
  distance2,
  type Observation,
  type Point,
  type Unit,
} from "../model.js";
import { OpeningStrategy } from "./strategy.js";
import {
  TaskRevision,
  type CombatMission,
  type StrategicController,
  type StrategicPlan,
  type TacticalAssessment,
} from "./contracts.js";

/** A local defender with persistent counterattack membership and a separate garrison. */
export class BastionStrategy implements StrategicController {
  readonly id = "bastion-strategy-v1";
  private readonly opening = new OpeningStrategy();
  private readonly revisions = new Map<string, TaskRevision>();
  private readonly productionRevision = new TaskRevision();
  private assault = new Set<string>();
  private joining = new Set<string>();
  private approach?: Point;
  private nextLaunchTick = 0;
  private readonly launchSize = 6;

  assessmentRequest(o: Observation) {
    return this.opening.assessmentRequest(o);
  }

  private mission(
    id: string,
    description: Omit<CombatMission, "id" | "revision">,
  ): CombatMission {
    let revision = this.revisions.get(id);
    if (!revision) this.revisions.set(id, (revision = new TaskRevision()));
    return {
      id,
      revision: revision.update({
        ...description,
        units: [...description.units].sort(),
      }),
      ...description,
    };
  }

  plan(o: Observation, assessment: TacticalAssessment): StrategicPlan {
    const base = this.opening.plan(o, assessment);
    const { unitType: armor, factoryType: factory } = this.assessmentRequest(o);
    const infantry = assessment.army.filter((u) => u.type === 3);
    const vehicles = assessment.army.filter((u) => u.type !== 3);
    const alive = new Set(vehicles.map((u) => u.ref));
    this.assault = new Set([...this.assault].filter((ref) => alive.has(ref)));
    this.joining = new Set([...this.joining].filter((ref) => alive.has(ref)));
    const threat = o.enemies
      .filter(
        (e) => e.type !== 2 && !e.airborne && distance2(e, o.home) < 30 ** 2,
      )
      .sort((a, b) => distance2(a, o.home) - distance2(b, o.home))[0];
    if (!this.approach && threat) this.approach = { x: threat.x, y: threat.y };
    const direction = this.approach ??
      o.starts
        .filter((p) => distance2(p, o.home) > 25)
        .sort((a, b) => distance2(a, o.home) - distance2(b, o.home))[0] ?? {
        x: o.home.x + 4,
        y: o.home.y + 4,
      };
    const dx = direction.x - o.home.x,
      dy = direction.y - o.home.y,
      length = Math.hypot(dx, dy) || 1;
    const post = {
      x: Math.round(o.home.x + (6 * dx) / length),
      y: Math.round(o.home.y + (6 * dy) / length),
    };
    const outsideFactory = (u: Unit) =>
      !o.own.some(
        (b) =>
          b.name === factory &&
          u.x >= b.x &&
          u.x < b.x + b.width &&
          u.y >= b.y &&
          u.y < b.y + b.height,
      );
    const center = (units: readonly Unit[]): Point => ({
      x: Math.round(units.reduce((s, u) => s + u.x, 0) / units.length),
      y: Math.round(units.reduce((s, u) => s + u.y, 0) / units.length),
    });
    let assault = vehicles.filter((u) => this.assault.has(u.ref));
    if (
      this.assault.size &&
      assault.filter((u) => u.name === armor).length <= 2
    ) {
      this.assault.clear();
      this.joining.clear();
      assault = [];
      this.nextLaunchTick = o.tick + 450;
    }
    let reserve = vehicles.filter(
      (u) => !this.assault.has(u.ref) && !this.joining.has(u.ref),
    );
    const ready = reserve.filter(
      (u) => outsideFactory(u) && distance2(u, post) <= 12 ** 2,
    );
    if (
      !this.assault.size &&
      o.tick >= this.nextLaunchTick &&
      ready.filter((u) => u.name === armor).length >=
        (o.tick >= 15000 ? 4 : this.launchSize)
    ) {
      this.assault = new Set(ready.map((u) => u.ref));
      assault = vehicles.filter((u) => this.assault.has(u.ref));
    }
    if (assault.length) {
      const mergePoint = center(assault);
      for (const u of vehicles.filter((u) => this.joining.has(u.ref)))
        if (distance2(u, mergePoint) <= 8 ** 2) {
          this.joining.delete(u.ref);
          this.assault.add(u.ref);
        }
      reserve = vehicles.filter(
        (u) => !this.assault.has(u.ref) && !this.joining.has(u.ref),
      );
      const nextBatch = reserve.filter(
        (u) => outsideFactory(u) && distance2(u, post) <= 12 ** 2,
      );
      if (
        !this.joining.size &&
        nextBatch.filter((u) => u.name === armor).length >= 4
      )
        this.joining = new Set(nextBatch.map((u) => u.ref));
    }
    assault = vehicles.filter((u) => this.assault.has(u.ref));
    const joiners = vehicles.filter((u) => this.joining.has(u.ref));
    reserve = vehicles.filter(
      (u) => !this.assault.has(u.ref) && !this.joining.has(u.ref),
    );
    const fort = o.side === 0 ? "GAPILL" : "NALASR";
    const economy = {
      ...base.production,
      defenses: [
        { product: fort, count: o.own.some((u) => u.name === factory) ? 1 : 0 },
      ],
    };
    const { revision: _oldRevision, ...productionDescription } = economy;
    const production = {
      ...economy,
      revision: this.productionRevision.update(productionDescription),
    };
    const combat = this.mission("main-force", {
      kind: assault.length ? "advance" : "defend",
      units: (assault.length ? assault : reserve).map((u) => u.ref),
      destination: assault.length ? base.combat.destination : post,
      groundDestination: assault.length ? base.combat.groundDestination : post,
      objective: assault.length
        ? base.combat.objective
        : "muster-counterattack",
      engagement: { allowCrush: assault.length > 0 },
    });
    const additionalCombat = [
      this.mission("base-garrison", {
        kind: "defend",
        units: infantry.map((u) => u.ref),
        destination: post,
        objective: "guard-base",
        engagement: { allowCrush: false },
      }),
    ];
    if (assault.length)
      additionalCombat.push(
        this.mission("reserve-force", {
          kind: "defend",
          units: reserve.map((u) => u.ref),
          destination: post,
          objective: "muster-reinforcements",
          engagement: { allowCrush: false },
        }),
      );
    if (joiners.length)
      additionalCombat.push(
        this.mission("reinforcements", {
          kind: "advance",
          units: joiners.map((u) => u.ref),
          destination: assault.length ? center(assault) : post,
          objective: "join-main-force",
          engagement: { allowCrush: false },
        }),
      );
    return { tick: o.tick, combat, additionalCombat, production };
  }
}
