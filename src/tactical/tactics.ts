import seedrandom from "seedrandom";
import { distance2, type Observation, type Intent } from "../model.js";
import { CommanderTactics } from "../commander/tactics.js";
import { NativeOrders } from "../control/native-orders.js";
import {
  currentEvidence,
  type TacticalController,
  type CombatMission,
  type ExecutionEvidence,
  type AssessmentRequest,
} from "../control/contracts.js";
import { tacticalWorld, type TacticalObservation } from "./world.js";
import type { NeuralTacticalPolicy } from "./network.js";

/** Experimental armor engagement skill. Other unit roles and native travel retain fixed tactics. */
export class LearnedArmorTactics implements TacticalController {
  readonly id = "commander-learned-armor-v1";
  readonly records: Record<string, unknown>[] = [];
  private readonly fixed = new CommanderTactics();
  private readonly orders = new NativeOrders();
  private readonly random: () => number;
  private lastTick = -1;
  private active = new Map<string, string>();
  constructor(
    private network: NeuralTacticalPolicy,
    seed = "0",
    private deterministic = true,
  ) {
    this.random = seedrandom(seed);
  }
  assess(o: Observation, r: AssessmentRequest) {
    return this.fixed.assess(o, r);
  }
  control(
    o: Observation,
    m: CombatMission,
    evidence: readonly ExecutionEvidence[],
  ) {
    if (this.lastTick !== o.tick) {
      this.records.length = 0;
      this.lastTick = o.tick;
    }
    const members = new Set(m.units);
    const armor =
      ["advance", "defend"].includes(m.kind) && m.destination
        ? o.own.filter(
            (u) =>
              members.has(u.ref) &&
              ["MTNK", "HTNK"].includes(u.name) &&
              o.enemies.some((e) => !e.airborne && distance2(u, e) <= 14 ** 2),
          )
        : [];
    const controlled = new Set(armor.map((u) => u.ref));
    const fixed = this.fixed.control(
      o,
      { ...m, units: m.units.filter((r) => !controlled.has(r)) },
      evidence,
    );
    for (const ref of m.units)
      if (!controlled.has(ref) && this.active.delete(ref))
        this.orders.forget(ref);
    if (!armor.length) return fixed;
    for (const u of armor) {
      const key = `${m.id}:${m.kind}:${m.revision}`;
      if (this.active.get(u.ref) !== key) {
        this.orders.forget(u.ref);
        this.active.set(u.ref, key);
      }
    }
    if (o.tick % 15 !== 0) return fixed;
    const center = {
      x: armor.reduce((s, u) => s + u.x, 0) / armor.length,
      y: armor.reduce((s, u) => s + u.y, 0) / armor.length,
    };
    const frame: TacticalObservation = {
      tick: o.tick,
      center,
      goal: m.destination!,
      task: m.kind as "advance" | "defend",
      own: armor.map((u) => ({
        ref: u.ref,
        x: u.x,
        y: u.y,
        onBridge: u.onBridge,
        hp: u.hp,
        maxHp: u.maxHp,
        range: u.weaponRange ?? 0,
        cooldown: u.weaponCooldown,
      })),
      enemies: o.enemies
        .filter(
          (e) => !e.airborne && armor.some((u) => distance2(u, e) <= 16 ** 2),
        )
        .map((e) => ({
          ref: e.ref,
          x: e.x,
          y: e.y,
          onBridge: e.onBridge,
          hp: e.hp,
          maxHp: e.maxHp,
          range: e.weaponRange ?? 0,
          infantry: e.type === 3,
          building: e.type === 2,
        })),
      ground: o.launchGeometry,
    };
    const world = tacticalWorld(frame),
      p = this.network.predict(world, this.random, this.deterministic),
      intents: Intent[] = [...fixed.intents];
    for (let i = 0; i < armor.length; i++) {
      const a = world.actions[i][p.choices[i]];
      if (a.kind === "keep") continue;
      const intent: Intent =
        a.kind === "attack"
          ? { kind: "attack", refs: [a.ref], target: a.target, task: m.id }
          : a.kind === "stop"
            ? { kind: "stop", refs: [a.ref], task: m.id }
            : { kind: a.kind, refs: [a.ref], ...a.point, task: m.id };
      if (this.orders.allow(armor[i], intent, o.tick)) intents.push(intent);
    }
    this.records.push({
      schema: "armor-skill-v1",
      tick: o.tick,
      task: m.id,
      world,
      choices: p.choices,
      logp: p.logp,
      value: p.value,
      executionSource: "policy",
    });
    return {
      origin: {
        id: m.id,
        revision: m.revision,
        controller: "tactics" as const,
      },
      intents,
      report: {
        task: { id: m.id, revision: m.revision },
        status: "active" as const,
        reason: "learned-armor-engagement",
        proposedIntents: intents.length,
        facts: {
          learnedArmor: armor.length,
          fixedUnits: m.units.length - armor.length,
        },
        executionEvidence: currentEvidence(m, evidence),
      },
    };
  }
}
