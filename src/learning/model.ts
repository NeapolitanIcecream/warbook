import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-cpu";
import {
  LAUNCH_SCHEMA,
  GLOBAL_SIZE,
  CANDIDATE_SIZE,
  type LaunchPolicy,
  type LaunchSnapshot,
} from "./launch.js";
export interface DenseLayer {
  input: number;
  output: number;
  weights: number[];
  bias: number[];
}
export interface LaunchModel {
  format: "warbook-launch-model-v1";
  schema: string;
  policyVersion: string;
  controlScope?: "launch" | "operation";
  actor: DenseLayer[];
  critic: DenseLayer[];
  training?: Record<string, unknown>;
}
export interface PolicyShape {
  schema: string;
  global: number;
  candidate: number;
}
export async function prepareInference() {
  await tf.setBackend("cpu");
  await tf.ready();
}
/** Same synchronous CPU evaluator is used by rollout workers and the player bundle. */
export class NeuralLaunchPolicy implements LaunchPolicy {
  private actor: { w: tf.Tensor2D; b: tf.Tensor1D }[];
  private critic: { w: tf.Tensor2D; b: tf.Tensor1D }[];
  constructor(
    readonly model: LaunchModel,
    private readonly shape: PolicyShape = {
      schema: LAUNCH_SCHEMA,
      global: GLOBAL_SIZE,
      candidate: CANDIDATE_SIZE,
    },
  ) {
    if (
      model.format !== "warbook-launch-model-v1" ||
      model.schema !== shape.schema
    )
      throw new Error("Incompatible launch model");
    const load = (layers: DenseLayer[], input: number) =>
      layers.map((l, i) => {
        if (
          l.input !== (i ? layers[i - 1].output : input) ||
          l.weights.length !== l.input * l.output ||
          l.bias.length !== l.output ||
          ![...l.weights, ...l.bias].every(Number.isFinite)
        )
          throw new Error("Invalid dense weights");
        return {
          w: tf.tensor2d(l.weights, [l.input, l.output]),
          b: tf.tensor1d(l.bias),
        };
      });
    if (model.actor.at(-1)?.output !== 1 || model.critic.at(-1)?.output !== 1)
      throw new Error("Expected scalar heads");
    this.actor = load(model.actor, shape.global + shape.candidate);
    this.critic = load(model.critic, shape.global);
  }
  predict(s: LaunchSnapshot) {
    return tf.tidy(() => {
      const dense = (x: tf.Tensor2D, layers: typeof this.actor) => {
        let y: tf.Tensor = x;
        layers.forEach((l, i) => {
          y = tf.add(tf.matMul(y as tf.Tensor2D, l.w), l.b);
          if (i < layers.length - 1) y = tf.tanh(y);
        });
        return y;
      };
      const x = tf.tensor2d(
        s.candidates.map((c) => [...s.global, ...c]),
        [s.candidates.length, this.shape.global + this.shape.candidate],
      );
      const logits = tf.reshape(dense(x, this.actor), [s.candidates.length]);
      const probabilities = Array.from(tf.softmax(logits).dataSync());
      const value = tf
        .sigmoid(
          dense(tf.tensor2d([s.global], [1, this.shape.global]), this.critic),
        )
        .dataSync()[0];
      if (
        !probabilities.every((p) => Number.isFinite(p) && p >= 0) ||
        !Number.isFinite(value)
      )
        throw new Error("Nonfinite launch prediction");
      const total = probabilities.reduce((a, b) => a + b, 0);
      if (!(total > 0)) throw new Error("Empty launch probability mass");
      return { probabilities: probabilities.map((p) => p / total), value };
    });
  }
  dispose() {
    for (const l of [...this.actor, ...this.critic]) {
      l.w.dispose();
      l.b.dispose();
    }
  }
}
