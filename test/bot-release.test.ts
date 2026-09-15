import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { buildBot } from "../scripts/build-bot.js";
import { loadBotRelease } from "../src/bot-release.js";
import { WarbookBot } from "../src/bridge.js";
import type { Observation } from "../src/model.js";

test("frozen builds are reproducible and preserve policy behavior with independent actor state", async () => {
  const release = await buildBot("HEAD");
  const rebuilt = await buildBot("HEAD");
  assert.equal(release.sha256, rebuilt.sha256);
  const { bot: first } = await loadBotRelease(release.path, "First");
  const { bot: second } = await loadBotRelease(release.path, "Second");
  assert.notEqual(first, second);
  assert.equal(
    first instanceof WarbookBot,
    false,
    "the driver must not depend on the working class identity",
  );
  const o: Observation = {
    tick: 0,
    side: 0,
    credits: 10000,
    power: { total: 200, drain: 0, isLowPower: false },
    home: { x: 25, y: 25 },
    starts: [
      { x: 25, y: 25 },
      { x: 70, y: 70 },
    ],
    own: [
      {
        ref: "tank",
        name: "MTNK",
        type: 7,
        x: 30,
        y: 30,
        hp: 400,
        maxHp: 400,
        width: 1,
        height: 1,
        mobile: true,
        idle: true,
        harvester: false,
        mcv: false,
        yard: false,
        refinery: false,
        combat: true,
      },
    ],
    enemies: [],
    products: [],
    queues: [],
    buildSites: [],
  };
  const expected = new WarbookBot("Working", "Americans", "combined");
  const contact = {
    ...o,
    enemies: [
      {
        ref: "contact",
        name: "HTNK",
        type: 7,
        x: 35,
        y: 35,
        hp: 300,
        maxHp: 300,
        observedTick: 0,
      },
    ],
  };
  assert.deepEqual(first.decide(contact), expected.decide(contact));
  const later = { ...o, tick: 450 };
  assert.deepEqual(first.decide(later), expected.decide(later));
  assert.deepEqual(
    second.decide(later),
    new WarbookBot("Fresh", "Americans", "combined").decide(later),
  );
  assert.notDeepEqual(
    second.decide({ ...o, tick: 900 }),
    first.decide({ ...o, tick: 900 }),
  );
});

test("a modified frozen artifact is refused before it can run", async () => {
  const release = await buildBot("HEAD");
  const dir = mkdtempSync(resolve("work/corrupt-bot-test-"));
  try {
    copyFileSync(release.path, `${dir}/release.json`);
    writeFileSync(
      `${dir}/bot.mjs`,
      "throw new Error('unverified code executed');",
    );
    await assert.rejects(
      loadBotRelease(`${dir}/release.json`, "Untrusted"),
      /artifact hash mismatch/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frozen runtime compatibility follows the SDK, not unrelated application lock metadata", async () => {
  const release = await buildBot("HEAD");
  const dir = mkdtempSync(resolve("work/bot-runtime-test-"));
  try {
    copyFileSync(resolve(release.path, "../bot.mjs"), `${dir}/bot.mjs`);
    const metadata = {
      ...JSON.parse(readFileSync(release.path, "utf8")),
      lockSha256: "0".repeat(64),
    };
    writeFileSync(`${dir}/release.json`, JSON.stringify(metadata));
    assert((await loadBotRelease(`${dir}/release.json`, "SameRuntime")).bot);
    writeFileSync(
      `${dir}/release.json`,
      JSON.stringify({ ...metadata, apiSha256: "0".repeat(64) }),
    );
    await assert.rejects(
      loadBotRelease(`${dir}/release.json`, "DifferentRuntime"),
      /dependencies differ/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
