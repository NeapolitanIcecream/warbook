import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NeuralCommanderPolicy,
  prepareCommander,
} from "../src/commander/network.js";

await prepareCommander();
const artifact = JSON.parse(readFileSync(process.argv[2], "utf8"));
const cases = JSON.parse(readFileSync(process.argv[3], "utf8"));
const base = new NeuralCommanderPolicy({ ...artifact, temperature: 1 });
const sharp = new NeuralCommanderPolicy({ ...artifact, temperature: 0.2 });
let checked = 0;
try {
  for (const sample of cases) {
    const p = base.predict(sample.world, sample.hidden, () => 0.5, true);
    const q = sharp.predict(sample.world, sample.hidden, () => 0.5, true);
    assert.deepEqual(q.action, p.action);
    assert.deepEqual(q.hidden, p.hidden);
    assert.equal(q.value, p.value);
    assert(q.entropy <= p.entropy + 1e-12);
    checked++;
  }
  for (const temperature of [0, -1, NaN, Infinity])
    assert.throws(
      () => new NeuralCommanderPolicy({ ...artifact, temperature }),
      /Invalid commander temperature/,
    );
} finally {
  base.dispose();
  sharp.dispose();
}
console.log(
  JSON.stringify({
    states: checked,
    greedyActionsPreserved: true,
    memoryAndValuePreserved: true,
    sharperConditionalDistributions: true,
  }),
);
