import { test } from "node:test";
import assert from "node:assert/strict";
import { policyPlayerName } from "../src/player-identity.js";

test("replay names preserve the release version and distinguish routes and mirror players", () => {
  assert.equal(
    policyPlayerName("warbook-0.1.14", "bastion", "A"),
    "bastion 0.1.14 A",
  );
  const names = [
    policyPlayerName("warbook-0.1.14", "bastion", "A"),
    policyPlayerName("warbook-0.1.14", "bastion", "B"),
    policyPlayerName("warbook-0.1.14", "pressure", "B"),
    policyPlayerName("warbook-0.1.13-pressure.1", "pressure", "B"),
  ];
  assert.equal(new Set(names).size, names.length);
  assert(names[3].includes("0.1.13-pressure.1"));
  assert.throws(() => policyPlayerName("0.1.14:fake", "bastion"), /delimiters/);
});
