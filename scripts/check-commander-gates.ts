import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import seedrandom from "seedrandom";
import {
  NeuralCommanderPolicy,
  prepareCommander,
} from "../src/commander/network.js";
import {
  actionEdits,
  type EncodedCommanderAction,
} from "../src/commander/action-mask.js";
import { keepAction, type CommanderWorld } from "../src/commander/world.js";

await prepareCommander();
const model = new NeuralCommanderPolicy(
  JSON.parse(readFileSync(process.argv[2], "utf8")),
  true,
);
assert.equal(model.encoding, "graph-plan-v3");
const samples = JSON.parse(readFileSync(process.argv[3], "utf8"));
const random = seedrandom("commander-edit-contract");
let sampled = 0,
  retyped = 0;
try {
  for (const sample of samples) {
    const w = sample.world as CommanderWorld;
    const held: EncodedCommanderAction = {
      ...keepAction(w),
      edits: [0, 0, 0, 0, 0],
    };
    const p = model.predict(w, sample.hidden, random, true, held);
    assert.deepEqual(p.action, held);
    assert(p.probabilities!.kind.every((row) => row[0] === 1));
    assert(p.probabilities!.unit.every((row) => row[18] === 1));
    const reviewed: EncodedCommanderAction = {
      ...held,
      edits: [
        1,
        1,
        Number(w.unitRefs.length > 0),
        Number(w.buildingRefs.length > 0),
        Number(w.placementObjects.length > 0),
      ],
    };
    const q = model.predict(w, sample.hidden, random, true, reviewed);
    assert.deepEqual(q.hidden, p.hidden);
    assert.notEqual(q.logp, p.logp); // Same external plan, different recorded latent choices.
    if (w.unitRefs.length)
      assert(
        q.probabilities!.unit.some(
          (row) => row.filter((p) => p > 0).length > 1,
        ),
      );
    for (let n = 0; n < 10; n++) {
      const sampledAction = model.predict(
        w,
        sample.hidden,
        random,
        false,
      ).action;
      actionEdits(sampledAction).forEach((changed, i) =>
        assert(!changed || sampledAction.edits![i] === 1),
      );
      sampled++;
    }
    const old = w.previousRoles.find(
      (role, i) => role < 16 && !w.unitCapabilities[i].building,
    );
    if (old !== undefined) {
      const a: EncodedCommanderAction = {
        ...keepAction(w),
        edits: [0, 1, 1, 0, 0],
      };
      a.kinds[old] = w.previousKinds[old] === 6 ? 2 : 6;
      a.goals[old] = w.goalObjects.findIndex((g) => g.kind !== "native");
      a.units = w.previousRoles.map((role) => (role === old ? old : 18));
      const p = model.predict(w, sample.hidden, random, true, a);
      assert.deepEqual(p.probabilities!.edit2, [[0, 1]]);
      assert.throws(
        () =>
          model.predict(w, sample.hidden, random, true, {
            ...a,
            edits: [0, 1, 0, 0, 0],
          }),
        /Invalid forced edit2/,
      );
      retyped++;
    }
  }
} finally {
  model.dispose();
}
assert(retyped > 0, "Need a real case with existing task members");
console.log(
  JSON.stringify({
    states: samples.length,
    sampled,
    retyped,
    latentChoicesPreserved: true,
    closedDomainsPreservePlan: true,
  }),
);
