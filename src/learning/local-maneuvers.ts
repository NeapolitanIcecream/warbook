import { distance2, type Point } from "../model.js";
import type { OperationContext } from "../control/operation-provider.js";
import type { OperationOrder } from "../control/armor-state.js";
import { formedUnits, rendezvous } from "../control/formation.js";
import { pointKey } from "../control/operation-state.js";

export type ManeuverScope = "base" | "local";
export const LOCAL_MAX_ACTIONS = 77;
export const isLocalManeuver = (order?: OperationOrder) =>
  order?.goal.kind === "local-regroup" || order?.goal.kind === "local-return";

/** Candidate locations witnessed occupied by this force. No SDK path query or
 * invented averaged tile: native movement owns the resulting full journey. */
export class LocalManeuvers {
  private trails = new Map<string, { point: Point; tick: number }[]>();

  observe(c: OperationContext): OperationOrder[] {
    const refs =
      c.state.order?.kind === "withdraw"
        ? c.state.withdrawing
        : c.state.assault;
    const force = c.observation.own.filter((u) => refs.has(u.ref));
    const visible = new Set(force.map((u) => u.ref));
    for (const ref of this.trails.keys())
      if (!visible.has(ref)) this.trails.delete(ref);
    const ground = force.filter((u) => !u.onBridge && !c.frame.covered(u));
    for (const u of ground) {
      const prior = (this.trails.get(u.ref) ?? []).filter(
        (p) => c.observation.tick - p.tick <= 900,
      );
      if (!prior.length || distance2(prior.at(-1)!.point, u) >= 2 ** 2)
        prior.push({ point: { x: u.x, y: u.y }, tick: c.observation.tick });
      this.trails.set(u.ref, prior.slice(-8));
    }
    if (!ground.length) return [];
    const center = rendezvous(
      formedUnits(ground, c.state.order?.goal.point ?? c.observation.home),
    );
    const goals: OperationOrder[] = [];
    const offer = (point: Point, kind: "local-regroup" | "local-return") => {
      if (
        c.frame.covered(point) ||
        goals.some((g) => pointKey(g.goal.point) === pointKey(point))
      )
        return;
      goals.push({
        kind: "withdraw",
        goal: { key: `${kind}:${pointKey(point)}`, point: { ...point }, kind },
      });
    };
    // Reposition is intentional even when enemies are close. The existing
    // assemble command prioritizes attacking and cannot promise this movement.
    if (force.some((u) => distance2(u, center) > 3 ** 2))
      offer(center, "local-regroup");
    const threats = c.observation.enemies.filter(
      (e) =>
        !e.airborne &&
        e.canThreatenVehicles !== false &&
        (e.weaponRange ?? 0) > 0,
    );
    const separation = (point: Point) =>
      threats.length
        ? Math.min(...threats.map((e) => distance2(point, e)))
        : distance2(point, c.state.order?.goal.point ?? c.observation.home);
    const history = [...this.trails.values()]
      .flat()
      .filter((p) => {
        const d = distance2(p.point, center);
        return (
          p.tick < c.observation.tick &&
          d >= 4 ** 2 &&
          d <= 10 ** 2 &&
          !c.frame.covered(p.point)
        );
      })
      .sort(
        (a, b) =>
          separation(b.point) - separation(a.point) ||
          b.tick - a.tick ||
          a.point.x - b.point.x ||
          a.point.y - b.point.y,
      );
    if (history.length) offer(history[0].point, "local-return");
    return goals;
  }
}
