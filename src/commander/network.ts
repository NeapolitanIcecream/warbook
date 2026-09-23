import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-backend-cpu";
import type { CommanderPolicy, CommanderPrediction } from "./controller.js";
import {
  goalMask,
  roleMask,
  TASK_SLOTS,
  TASK_KINDS,
  type CommanderAction,
  type CommanderWorld,
} from "./world.js";

export interface CommanderModel {
  format: "warbook-commander-model-v1";
  schema: "commander-v1";
  encoding: "graph-plan-v1";
  hidden: number;
  vocabulary: string[];
  tensors: Record<string, { shape: number[]; values: number[] }>;
  training?: Record<string, unknown>;
}
export async function prepareCommander() {
  await tf.setBackend("cpu");
  await tf.ready();
}

/** Mirrors the small PyTorch model; recurrent state belongs to each game controller. */
export class NeuralCommanderPolicy implements CommanderPolicy {
  readonly hiddenSize: number;
  private tensors: Record<string, tf.Tensor> = {};
  private names: Map<string, number>;
  constructor(
    readonly artifact: CommanderModel,
    private collectProbabilities = false,
  ) {
    if (
      artifact.format !== "warbook-commander-model-v1" ||
      artifact.schema !== "commander-v1" ||
      artifact.encoding !== "graph-plan-v1" ||
      artifact.hidden !== 128
    )
      throw new Error("Unsupported commander artifact");
    this.hiddenSize = artifact.hidden;
    this.names = new Map(artifact.vocabulary.map((n, i) => [n, i + 1]));
    for (const [name, value] of Object.entries(artifact.tensors)) {
      if (
        value.shape.reduce((n, d) => n * d, 1) !== value.values.length ||
        !value.values.every(Number.isFinite)
      )
        throw new Error("Invalid commander weights");
      this.tensors[name] = tf.tensor(value.values, value.shape);
    }
  }
  dispose() {
    for (const t of Object.values(this.tensors)) t.dispose();
  }
  predict(
    w: CommanderWorld,
    hidden: readonly number[],
    random: () => number,
    deterministic: boolean,
    forced?: CommanderAction,
  ): CommanderPrediction {
    let result!: CommanderPrediction;
    tf.tidy(() => {
      const matrix = (rows: number[][], width: number) =>
        tf.tensor2d(rows.length ? rows : [Array(width).fill(0)], [
          Math.max(1, rows.length),
          width,
        ]);
      const linear = (x: tf.Tensor2D, name: string) =>
        tf.add(
          tf.matMul(
            x,
            this.tensors[name + ".weight"] as tf.Tensor2D,
            false,
            true,
          ),
          this.tensors[name + ".bias"],
        ) as tf.Tensor2D;
      const dense = (x: tf.Tensor2D, name: string) =>
        tf.tanh(linear(x, name)) as tf.Tensor2D;
      const names = (xs: string[]) =>
        tf.gather(
          this.tensors["names.weight"],
          tf.tensor1d(
            xs.length ? xs.map((n) => this.names.get(n) ?? 0) : [0],
            "int32",
          ),
        ) as tf.Tensor2D;
      const gather = (x: tf.Tensor2D, indices: number[]) =>
        tf.gather(
          x,
          tf.tensor1d(
            indices.length ? indices.map((i) => Math.max(0, i)) : [0],
            "int32",
          ),
        ) as tf.Tensor2D;
      const tile = (x: tf.Tensor2D, n: number) =>
        tf.tile(x, [Math.max(1, n), 1]);
      const cat = (xs: tf.Tensor2D[]) => tf.concat(xs, 1) as tf.Tensor2D;
      const row = (x: tf.Tensor2D, i: number) =>
        tf.slice(x, [i, 0], [1, x.shape[1]]) as tf.Tensor2D;
      const neighbors = (x: tf.Tensor2D, edges: [number, number][]) => {
        if (!edges.length) return tf.zerosLike(x) as tf.Tensor2D;
        // CPU UnsortedSegmentSum loops over every segment. The existing sparse
        // kernel visits edges directly; sorting preserves their within-node order.
        const sorted = [...edges].sort((a,b)=>a[1]-b[1]);
        let data = x;
        if(sorted.at(-1)![1]!==x.shape[0]-1) {
          data=tf.concat([x,tf.zeros([1,x.shape[1]])],0) as tf.Tensor2D;
          sorted.push([x.shape[0],x.shape[0]-1]);
        }
        return tf.sparse.sparseSegmentMean(data,
          tf.tensor1d(sorted.map(e=>e[0]),"int32"),
          tf.tensor1d(sorted.map(e=>e[1]),"int32")) as tf.Tensor2D;
      };
      const summary = (x: tf.Tensor2D, n: number) =>
        n
          ? cat([
              tf.mean(x, 0, true) as tf.Tensor2D,
              tf.max(x, 0, true) as tf.Tensor2D,
            ])
          : (tf.zeros([1, x.shape[1] * 2]) as tf.Tensor2D);
      let e = dense(
        cat([matrix(w.entities, 64), names(w.entityNames)]),
        "entity0",
      );
      e = dense(cat([e, neighbors(e, w.entityEdges)]), "entity1");
      let r = dense(matrix(w.regions, 16), "region0");
      r = dense(cat([r, neighbors(r, w.regionEdges)]), "region1");
      let p = dense(
        cat([matrix(w.products, 24), names(w.productNames)]),
        "product0",
      );
      p = dense(cat([p, neighbors(p, w.productEdges)]), "product1");
      const ge = tf.mul(
        gather(e, w.goalEntities),
        tf.tensor2d(w.goalEntities.map((i) => [Number(i >= 0)])),
      ) as tf.Tensor2D;
      const g = dense(
          cat([matrix(w.goals, 32), ge, names(w.goalNames)]),
          "goal0",
        ),
        places = dense(matrix(w.placements, 32), "place0");
      const tasks = dense(matrix(w.tasks, 32), "task0"),
        queues = matrix(w.queues, 16),
        queueNames = names(w.queueNames);
      const x = dense(
        cat([
          matrix([w.global], 32),
          summary(e, w.entities.length),
          summary(r, w.regions.length),
          summary(p, w.products.length),
          summary(tasks, TASK_SLOTS),
          tf.reshape(queues, [1, 96]) as tf.Tensor2D,
          tf.reshape(queueNames, [1, 96]) as tf.Tensor2D,
        ]),
        "world0",
      );
      const h0 = matrix([[...hidden]], 128);
      const input = tf.add(
        tf.matMul(
          x,
          this.tensors["memory.weight_ih"] as tf.Tensor2D,
          false,
          true,
        ),
        this.tensors["memory.bias_ih"],
      );
      const recurrent = tf.add(
        tf.matMul(
          h0,
          this.tensors["memory.weight_hh"] as tf.Tensor2D,
          false,
          true,
        ),
        this.tensors["memory.bias_hh"],
      );
      const [ir, iz, inn] = tf.split(input, 3, 1),
        [hr, hz, hn] = tf.split(recurrent, 3, 1);
      const reset = tf.sigmoid(tf.add(ir, hr)),
        update = tf.sigmoid(tf.add(iz, hz));
      const proposal = tf.tanh(tf.add(inn, tf.mul(reset, hn)));
      const h = tf.add(
        tf.mul(tf.sub(1, update), proposal),
        tf.mul(update, h0),
      ) as tf.Tensor2D;
      let logp = 0,
        entropy = 0,
        factors = 0;
      const probabilities: Record<string, number[][]> = {};
      const choose = (
        name: string,
        logits: tf.Tensor2D,
        masks: boolean[][],
        given?: number[],
      ) => {
        const raw = logits.dataSync(),
          width = logits.shape[1],
          choices: number[] = [];
        const rows: number[][] = [];
        for (let i = 0; i < masks.length; i++) {
          const mask = masks[i];
          if (mask.length !== width || !mask.some(Boolean))
            throw new Error(`Empty/mismatched ${name} mask`);
          const values = Array.from(raw.slice(i * width, (i + 1) * width));
          const maximum = Math.max(...values.filter((_, j) => mask[j]));
          const exp = values.map((v, j) =>
              mask[j] ? Math.exp(v - maximum) : 0,
            ),
            total = exp.reduce((a, b) => a + b, 0),
            probs = exp.map((v) => v / total);
          let selected = given?.[i];
          if (selected === undefined) {
            if (deterministic) selected = probs.indexOf(Math.max(...probs));
            else {
              let q = random();
              selected = mask.lastIndexOf(true);
              for (let j = 0; j < probs.length; j++) {
                q -= probs[j];
                if (q < 0 && mask[j]) {
                  selected = j;
                  break;
                }
              }
            }
          }
          if (!mask[selected]) throw new Error(`Invalid forced ${name} action`);
          if (mask.filter(Boolean).length > 1) {
            logp += Math.log(Math.max(1e-30, probs[selected]));
            entropy -= probs.reduce((n, v) => n + (v ? v * Math.log(v) : 0), 0);
            factors++;
          }
          choices.push(selected);
          rows.push(probs);
        }
        if (this.collectProbabilities) probabilities[name] = rows;
        return choices;
      };
      const one = (i: number, n: number) =>
        Array.from({ length: n }, (_, j) => Number(i === j));
      const a: CommanderAction = {
        queues: [],
        amounts: [],
        cash: [],
        kinds: [],
        goals: [],
        engagement: [],
        units: [],
        buildings: [],
        placements: [],
      };
      let context = tf.zeros([1, 64]) as tf.Tensor2D;
      for (let q = 0; q < 6; q++) {
        const query = dense(
          cat([h, row(queues, q), row(queueNames, q), context]),
          "queue0",
        );
        const logits = cat([
          linear(query, "queueSpecial"),
          tf.div(tf.matMul(query, p, false, true), 8) as tf.Tensor2D,
        ]);
        const selected = choose(
          `queue${q}`,
          logits,
          [[true, true, true, true, ...w.productQueues.map((i) => i === q)]],
          forced ? [forced.queues[q]] : undefined,
        )[0];
        a.queues.push(selected);
        const key =
          selected >= 4
            ? row(p, selected - 4)
            : row(this.tensors["queueSpecialKeys"] as tf.Tensor2D, selected);
        const parameters = linear(cat([query, key]), "queueParameter"),
          active = selected >= 4;
        const amount = choose(
          `amount${q}`,
          tf.slice(parameters, [0, 0], [1, 5]),
          [Array.from({ length: 5 }, (_, i) => active || i === 0)],
          forced ? [forced.amounts[q]] : undefined,
        )[0];
        const cash = choose(
          `cash${q}`,
          tf.slice(parameters, [0, 5], [1, 6]),
          [Array.from({ length: 6 }, (_, i) => active || i === 0)],
          forced ? [forced.cash[q]] : undefined,
        )[0];
        a.amounts.push(amount);
        a.cash.push(cash);
        context = dense(
          cat([
            context,
            key,
            matrix(
              [
                [
                  ...one(amount, 5),
                  ...one(cash, 6),
                  ...one(Math.min(selected, 4), 5),
                ],
              ],
              16,
            ),
          ]),
          "queueContext",
        );
      }
      const slots = this.tensors["slots.weight"] as tf.Tensor2D;
      const tq = dense(
        cat([tile(h, TASK_SLOTS), tasks, slots, tile(context, TASK_SLOTS)]),
        "taskQuery",
      );
      const km = w.previousKinds.map((old) =>
        TASK_KINDS.map((_, k) =>
          k === 1
            ? old >= 2
            : k === 7
              ? w.goalObjects.some((g) => g.kind === "tech")
              : true,
        ),
      );
      a.kinds = choose("kind", linear(tq, "kind"), km, forced?.kinds);
      const actualKinds = a.kinds.map((k, i) => k || w.previousKinds[i]);
      const ke = gather(
        this.tensors["kindEmbedding.weight"] as tf.Tensor2D,
        actualKinds,
      );
      const gq = dense(cat([tq, ke]), "goalQuery");
      const active = a.kinds.map((k) => k >= 2 && k !== 10);
      const gm = a.kinds.map((k, i) =>
        active[i]
          ? goalMask(w, k)
          : w.goalObjects.map((_, j) => j === w.previousGoals[i]),
      );
      a.goals = choose(
        "goal",
        tf.div(tf.matMul(gq, g, false, true), 8) as tf.Tensor2D,
        gm,
        forced?.goals,
      );
      a.engagement = choose(
        "engagement",
        linear(tq, "engagement"),
        active.map((on) => Array.from({ length: 8 }, (_, i) => on || i === 0)),
        forced?.engagement,
      );
      const actualGoals = a.kinds.map((k, i) =>
        actualKinds[i] < 2 || actualKinds[i] === 10
          ? 0
          : k
            ? a.goals[i]
            : w.previousGoals[i],
      );
      const taskKeys = dense(cat([tq, gather(g, actualGoals), ke]), "roleKeys");
      const uq = dense(
        cat([gather(e, w.unitIndices), tile(h, w.unitRefs.length)]),
        "unitQuery",
      );
      const roleKeys = tf.concat(
        [taskKeys, this.tensors["roleSpecialKeys"]],
        0,
      ) as tf.Tensor2D;
      a.units = choose(
        "unit",
        tf.div(tf.matMul(uq, roleKeys, false, true), 8) as tf.Tensor2D,
        w.unitRefs.map((_, i) => roleMask(w, i, a.kinds)),
        forced?.units,
      );
      const bq = dense(
        cat([gather(e, w.buildingIndices), tile(h, w.buildingRefs.length)]),
        "building0",
      );
      a.buildings = choose(
        "building",
        linear(bq, "building1"),
        w.buildingCapabilities.map((c) => [true, c.repair, c.repair, c.sell]),
        forced?.buildings,
      );
      for (let q = 0; q < 2; q++) {
        const pq = dense(
          cat([h, row(queues, q), row(queueNames, q)]),
          "placeQuery",
        );
        let logits = cat([
          linear(pq, "placeKeep"),
          tf.div(tf.matMul(pq, places, false, true), 8) as tf.Tensor2D,
        ]);
        if (!w.placementObjects.length)
          logits = tf.slice(logits, [0, 0], [1, 1]);
        a.placements.push(
          choose(
            `place${q}`,
            logits,
            [[true, ...w.placementObjects.map((p) => p.queue === q)]],
            forced ? [forced.placements[q]] : undefined,
          )[0],
        );
      }
      const value = tf
        .sigmoid(linear(dense(h, "value0"), "value1"))
        .dataSync()[0];
      const nextHidden = Array.from(h.dataSync());
      if (![value, logp, entropy, ...nextHidden].every(Number.isFinite))
        throw new Error("Nonfinite commander prediction");
      result = {
        action: a,
        logp,
        value,
        entropy: entropy / Math.max(1, factors),
        hidden: nextHidden,
        ...(this.collectProbabilities ? { probabilities } : {}),
      };
    });
    return result;
  }
}
