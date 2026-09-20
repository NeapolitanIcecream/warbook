import { readFileSync } from "node:fs";
import { prepareInference, NeuralLaunchPolicy } from "../src/learning/model.js";
import type { LaunchSnapshot } from "../src/learning/launch.js";
await prepareInference();
const model = new NeuralLaunchPolicy(
  JSON.parse(readFileSync(process.argv[2], "utf8")),
);
const samples = JSON.parse(readFileSync(process.argv[3], "utf8"));
if (!samples.some((s: LaunchSnapshot) => s.candidates.length > 1))
  throw new Error("Parity samples contain no policy choices");
let maxError = 0;
for (const sample of samples) {
  const p = model.predict(sample as LaunchSnapshot);
  if (p.probabilities.length !== sample.probabilities.length)
    throw new Error("Parity action count mismatch");
  maxError = Math.max(
    maxError,
    Math.abs(p.value - sample.value),
    ...p.probabilities.map((v, i) => Math.abs(v - sample.probabilities[i])),
  );
}
model.dispose();
if (!Number.isFinite(maxError) || maxError > 1e-5)
  throw new Error(`Cross-runtime model error ${maxError}`);
console.log(
  JSON.stringify({
    samples: samples.length,
    candidateCounts: samples.map((s: LaunchSnapshot) => s.candidates.length),
    maxError,
    withinTolerance: true,
  }),
);
