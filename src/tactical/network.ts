import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-cpu";
import type { TacticalWorld } from "./world.js";

export interface TacticalModel {
  format: "warbook-armor-skill-v1";
  tensors: Record<string, { shape: number[]; values: number[] }>;
  training?: Record<string, unknown>;
}
export async function prepareTactical() {
  await tf.setBackend("cpu");
  await tf.ready();
}
export class NeuralTacticalPolicy {
  private tensors: Record<string, tf.Tensor> = {};
  constructor(readonly artifact: TacticalModel) {
    if (artifact.format !== "warbook-armor-skill-v1")
      throw new Error("Unsupported armor skill");
    for (const [name, t] of Object.entries(artifact.tensors)) {
      if (
        t.values.length !== t.shape.reduce((a, b) => a * b, 1) ||
        !t.values.every(Number.isFinite)
      )
        throw new Error("Invalid armor weights");
      this.tensors[name] = tf.tensor(t.values, t.shape);
    }
  }
  dispose() {
    Object.values(this.tensors).forEach((t) => t.dispose());
  }
  predict(
    w: TacticalWorld,
    random: () => number,
    deterministic: boolean,
    forced?: number[],
  ) {
    return tf.tidy(() => {
      const linear = (x: tf.Tensor2D, n: string) =>
        tf.add(
          tf.matMul(x, this.tensors[n + ".weight"] as tf.Tensor2D, false, true),
          this.tensors[n + ".bias"],
        ) as tf.Tensor2D;
      const dense = (x: tf.Tensor2D, n: string) =>
        tf.tanh(linear(x, n)) as tf.Tensor2D;
      const e = dense(
        dense(
          tf.tensor2d(w.entities.length ? w.entities : [Array(20).fill(0)]),
          "entity0",
        ),
        "entity1",
      );
      const mean = (start: number, n: number) =>
        n
          ? tf.mean(tf.slice(e, [start, 0], [n, 48]), 0, true)
          : tf.zeros([1, 48]);
      const context = dense(
        tf.concat(
          [
            tf.tensor2d([w.global]),
            mean(0, w.ownCount),
            mean(w.ownCount, w.entities.length - w.ownCount),
          ],
          1,
        ) as tf.Tensor2D,
        "context",
      );
      const value = tf
        .sigmoid(linear(dense(context, "value0"), "value1"))
        .dataSync()[0];
      const choices: number[] = [],
        probabilities: number[][] = [];
      let logp = 0,
        entropy = 0;
      for (let i = 0; i < w.ownCount; i++) {
        const query = dense(
          tf.concat([tf.slice(e, [i, 0], [1, 48]), context], 1) as tf.Tensor2D,
          "query",
        );
        const targets = w.targets[i];
        const te = tf.mul(
          tf.gather(
            e,
            targets.map((j) => Math.max(0, j)),
          ),
          tf.tensor2d(targets.map((j) => [Number(j >= 0)])),
        );
        const keys = dense(
          tf.concat([tf.tensor2d(w.candidates[i]), te], 1) as tf.Tensor2D,
          "key",
        );
        const probs = Array.from(
          tf.softmax(tf.div(tf.sum(tf.mul(keys, query), 1), 8)).dataSync(),
        );
        let chosen = forced?.[i];
        if (chosen === undefined) {
          if (deterministic) chosen = probs.indexOf(Math.max(...probs));
          else {
            let r = random();
            chosen = probs.length - 1;
            for (let j = 0; j < probs.length; j++) {
              r -= probs[j];
              if (r < 0) {
                chosen = j;
                break;
              }
            }
          }
        }
        if (!Number.isInteger(chosen) || chosen < 0 || chosen >= probs.length)
          throw new Error("Invalid armor choice");
        choices.push(chosen);
        probabilities.push(probs);
        logp += Math.log(Math.max(1e-30, probs[chosen]));
        entropy -= probs.reduce((s, p) => s + (p ? p * Math.log(p) : 0), 0);
      }
      return {
        choices,
        probabilities,
        logp,
        value,
        entropy: entropy / Math.max(1, w.ownCount),
      };
    });
  }
}
