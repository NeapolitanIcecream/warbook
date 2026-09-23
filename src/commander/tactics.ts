import type { Intent, Observation } from "../model.js";
import { PositionTactics } from "../control/position-tactics.js";
import {
  currentEvidence,
  type CombatMission,
  type ExecutionEvidence,
  type ControlResult,
} from "../control/contracts.js";

/** Versioned fixed tactics for the first whole-strategy learner. */
export class CommanderTactics extends PositionTactics {
  override readonly id = "commander-fixed-tactics-v1";
  private holding = new Set<string>();
  private miningTargets = new Map<string, string>();
  override releaseUnit(ref: string): void {
    super.releaseUnit(ref);
    this.holding.delete(ref);
    this.miningTargets.delete(ref);
  }
  override control(
    o: Observation,
    m: CombatMission,
    evidence: readonly ExecutionEvidence[],
  ): ControlResult {
    if (m.kind !== "harvest")
      for (const ref of m.units) this.miningTargets.delete(ref);
    if (m.kind !== "hold") {
      for (const ref of m.units) this.holding.delete(ref);
      const filtered =
        m.kind === "capture" && o.capturableBuildings
          ? { ...o, techBuildings: o.capturableBuildings }
          : m.kind === "harvest" && m.destination
            ? {
                ...o,
                oreFields: o.oreFields?.filter(
                  (p) =>
                    (p.x - m.destination!.x) ** 2 +
                      (p.y - m.destination!.y) ** 2 <=
                    12 ** 2,
                ),
              }
            : o;
      const result = super.control(filtered, m, evidence);
      const added: Intent[] = [];
      if (m.kind === "harvest" && m.destination)
        for (const ref of m.units) {
          const unit = o.own.find((u) => u.ref === ref && u.harvester);
          const key = `${m.id}:${m.destination.x}:${m.destination.y}`;
          if (
            unit &&
            this.miningTargets.get(ref) !== key &&
            !result.intents.some((i) => "refs" in i && i.refs.includes(ref))
          ) {
            added.push({
              kind: "gather",
              refs: [ref],
              ...m.destination,
              task: m.id,
            });
            this.miningTargets.set(ref, key);
          }
        }
      return added.length
        ? {
            ...result,
            intents: [...result.intents, ...added],
            report: {
              ...result.report,
              proposedIntents: result.intents.length + added.length,
            },
          }
        : result;
    }
    this.prepareMission(m);
    if (m.objective === "preserve-native")
      for (const ref of m.units) this.holding.delete(ref);
    const refs =
      m.objective === "preserve-native"
        ? []
        : m.units.filter(
            (ref) =>
              !this.holding.has(ref) &&
              o.own.some((u) => u.ref === ref && u.type !== 2),
          );
    for (const ref of refs) this.holding.add(ref);
    for (const ref of o.ownDepartures ?? []) this.holding.delete(ref);
    const intents = refs.length
      ? [{ kind: "stop" as const, refs, task: m.id }]
      : [];
    return {
      origin: { id: m.id, revision: m.revision, controller: "tactics" },
      intents,
      report: {
        task: { id: m.id, revision: m.revision },
        status: "idle",
        reason: "explicit-hold",
        proposedIntents: intents.length,
        facts: {},
        executionEvidence: currentEvidence(m, evidence),
      },
    };
  }
}
