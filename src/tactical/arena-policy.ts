import seedrandom from "seedrandom";
import type { ArenaObservation, ArenaPolicy } from "../arena.js";
import {
  tacticalWorld,
  focusLabels,
  type TacticalObservation,
} from "./world.js";
import type { NeuralTacticalPolicy } from "./network.js";

export class ArmorArenaPolicy implements ArenaPolicy {
  private random: () => number;
  constructor(
    private network?: NeuralTacticalPolicy,
    seed = "0",
    private deterministic = false,
  ) {
    this.random = seedrandom(seed);
  }
  decide(o: ArenaObservation) {
    const observation: TacticalObservation = {
      ...o,
      goal: o.center,
      task: "advance",
    };
    const world = tacticalWorld(observation);
    const prediction = this.network?.predict(
      world,
      this.random,
      this.deterministic,
    );
    const choices = prediction?.choices ?? focusLabels(observation, world);
    return {
      actions: choices.map((c, i) => world.actions[i][c]),
      record: {
        schema: "armor-skill-v1",
        world,
        choices,
        logp: prediction?.logp ?? 0,
        value: prediction?.value ?? 0,
        executionSource: this.network ? "policy" : "teacher",
      },
    };
  }
}
