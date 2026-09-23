import { readFileSync } from "node:fs";
import {
  NeuralTacticalPolicy,
  prepareTactical,
} from "../src/tactical/network.js";
await prepareTactical();
const model = new NeuralTacticalPolicy(
  JSON.parse(readFileSync(process.argv[2], "utf8")),
);
const cases = JSON.parse(readFileSync(process.argv[3], "utf8"));
let maximum = 0,
  compared = 0;
function check(a: any, b: any) {
  if (typeof b === "number") {
    const d = Math.abs(a - b);
    if (!Number.isFinite(d)) throw new Error("Nonfinite parity value");
    maximum = Math.max(maximum, d);
    compared++;
  } else if (Array.isArray(b)) {
    if (a.length !== b.length) throw new Error("Parity shape mismatch");
    b.forEach((x, i) => check(a[i], x));
  } else for (const k of Object.keys(b)) check(a[k], b[k]);
}
try {
  for (const c of cases)
    check(
      model.predict(c.world, () => 0.5, true, c.choices),
      c.expected,
    );
} finally {
  model.dispose();
}
console.log(
  JSON.stringify({
    cases: cases.length,
    compared,
    maxAbsoluteError: maximum,
    withinTolerance: maximum < 1e-4,
  }),
);
if (maximum >= 1e-4) process.exitCode = 1;
