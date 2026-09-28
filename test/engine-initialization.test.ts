import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  createWithInitializationGate,
  offlineInitialization,
} from "../src/engine-initialization.js";

test("replay input identity groups matching seconds without confusing map or rules with random source", () => {
  const header = {
    gameId: "0",
    gameTimestamp: 1790566283,
    engineVersion: "0.83",
    modHash: 1766070753,
    gameOpts: { mapDigest: "first" },
  };
  const first = offlineInitialization(header, "rules-one");
  const anotherMap = offlineInitialization(
    { ...header, gameOpts: { mapDigest: "second" } },
    "rules-two",
  );
  assert.equal(first.randomSourceKey, anotherMap.randomSourceKey);
  assert.notEqual(first.mapDigest, anotherMap.mapDigest);
  assert.notEqual(first.rulesHash, anotherMap.rulesHash);
  assert.notEqual(
    first.randomSourceKey,
    offlineInitialization(
      { ...header, gameTimestamp: header.gameTimestamp + 1 },
      "rules-one",
    ).randomSourceKey,
  );
  assert.throws(() =>
    offlineInitialization({ ...header, gameId: "online" }, "rules-one"),
  );
});

test("parallel gate users initialize in distinct seconds and release the lock before their games continue", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "warbook-init-gate-"));
  try {
    const started: number[] = [];
    let active = 0,
      maximumActive = 0;
    const entered: number[] = [];
    const pending = [];
    for (let value = 0; value < 6; value++) {
      pending.push(
        createWithInitializationGate(async () => {
          maximumActive = Math.max(maximumActive, ++active);
          entered.push(value);
          started.push(Date.now());
          await delay(30);
          --active;
          return value;
        }, directory),
      );
      // Different request milliseconds make expected FIFO order unambiguous.
      await delay(5);
    }
    const results = await Promise.all(pending);
    assert.equal(maximumActive, 1);
    assert.equal(new Set(started.map((t) => Math.floor(t / 1000))).size, 6);
    assert.deepEqual(entered, [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(
      results.map((r) => r.value),
      [0, 1, 2, 3, 4, 5],
    );
    assert.equal(existsSync(resolve(directory, "owner.json")), false);
    assert.equal(
      readdirSync(directory).some((n) => n.startsWith("pending-")),
      false,
    );
    assert.ok(
      results.every(
        (r) => r.timing.createFinishedAtMs >= r.timing.createStartedAtMs,
      ),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("failed initialization releases its gate, and an ungated call preserves its error", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "warbook-init-error-"));
  try {
    const fail = async () => {
      throw new Error("create failed");
    };
    await assert.rejects(
      createWithInitializationGate(fail, directory),
      /create failed/,
    );
    assert.equal(existsSync(resolve(directory, "owner.json")), false);
    await assert.rejects(createWithInitializationGate(fail), /create failed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stale owner fails closed without deleting a lock another process could replace", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "warbook-init-stale-"));
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(dead.status, 0);
    const owner = JSON.stringify({ pid: dead.pid, requestedAtMs: Date.now() });
    writeFileSync(resolve(directory, "owner.json"), owner);
    await assert.rejects(
      createWithInitializationGate(async () => 1, directory),
      /Stale initialization gate owner/,
    );
    assert.equal(readFileSync(resolve(directory, "owner.json"), "utf8"), owner);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a dead queued process is reported and other request tickets are cleaned up", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "warbook-init-dead-waiter-"));
  try {
    const dead = spawnSync(process.execPath, ["-e", ""]);
    assert.equal(dead.status, 0);
    const name = "pending-0000000000000000-dead.json";
    writeFileSync(resolve(directory, name), JSON.stringify({ pid: dead.pid }));
    await assert.rejects(
      createWithInitializationGate(async () => 1, directory),
      /Stale initialization gate waiter/,
    );
    assert.deepEqual(readdirSync(directory), [name]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
