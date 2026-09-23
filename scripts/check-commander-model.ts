import { readFileSync } from "node:fs";
import {
  NeuralCommanderPolicy,
  prepareCommander,
} from "../src/commander/network.js";

await prepareCommander();
const model = new NeuralCommanderPolicy(
  JSON.parse(readFileSync(process.argv[2], "utf8")),
  true,
);
const cases = JSON.parse(readFileSync(process.argv[3], "utf8"));
let maximum = 0,
  compared = 0;
function compare(a: unknown, b: unknown, path: string) {
  if (typeof a === "number" && typeof b === "number") {
    const d = Math.abs(a - b);
    if (!Number.isFinite(d)) throw new Error("Nonfinite " + path);
    maximum = Math.max(maximum, d);
    compared++;
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) throw new Error("Length mismatch " + path);
    a.forEach((x, i) => compare(x, b[i], path + "/" + i));
    return;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const key of Object.keys(b))
      compare((a as any)[key], (b as any)[key], path + "/" + key);
    return;
  }
  throw new Error("Type mismatch " + path);
}
try {
  for (const sample of cases) {
    const actual = model.predict(
      sample.world,
      sample.hidden,
      () => 0.5,
      true,
      sample.action,
    );
    compare(actual, sample.expected, "sample");
  }
} finally {
  model.dispose();
}
const withinTolerance = maximum < 1e-4;
console.log(
  JSON.stringify({
    cases: cases.length,
    compared,
    maxAbsoluteError: maximum,
    withinTolerance,
  }),
);
if (!withinTolerance) process.exitCode = 1;
