import { test } from "node:test";
import assert from "node:assert/strict";
import { LearnedArmorTactics } from "../src/tactical/tactics.js";
import type { NeuralTacticalPolicy } from "../src/tactical/network.js";
import type { Observation } from "../src/model.js";
import type { CombatMission } from "../src/control/contracts.js";
import {
  tacticalWorld,
  focusLabels,
  type TacticalObservation,
} from "../src/tactical/world.js";

test("tactical choices preserve native orders and expose only visible targets", () => {
  const o: TacticalObservation = {
    tick: 0,
    center: { x: 20, y: 20 },
    goal: { x: 20, y: 20 },
    radius: 10,
    task: "advance",
    own: [
      {
        ref: "ours",
        x: 16,
        y: 20,
        hp: 300,
        maxHp: 300,
        range: 5,
        cooldown: 12,
      },
    ],
    enemies: [
      {
        ref: "seen",
        x: 23,
        y: 20,
        hp: 20,
        maxHp: 300,
        range: 5,
        cooldown: 999,
      },
    ],
  };
  const w = tacticalWorld(o);
  assert.equal(w.entities[1][6], 0);
  assert.equal(w.entities[1][7], 0);
  assert.equal(w.actions[0][focusLabels(o, w)[0]].kind, "attack");
  assert(w.actions[0].some((a) => a.kind === "move"));
  assert(w.actions[0].some((a) => a.kind === "attackMove"));
  assert(
    w.actions[0].every(
      (a) =>
        !("point" in a) || (a.point.x - 20) ** 2 + (a.point.y - 20) ** 2 <= 100,
    ),
  );
  const empty = tacticalWorld({ ...o, enemies: [] });
  assert(empty.actions[0].every((a) => a.kind !== "attack"));
});

test("armor skill honors consecutive changed orders and hands infantry contact back to crushing", () => {
  let target = "enemy-a",
    calls = 0;
  const network = {
    predict(w: any) {
      calls++;
      return {
        choices: w.actions.map((a: any[]) =>
          a.findIndex((x) => x.kind === "attack" && x.target === target),
        ),
        logp: 0,
        value: 0.5,
      };
    },
  } as unknown as NeuralTacticalPolicy;
  const tactics = new LearnedArmorTactics(network, "test", true, "duel");
  const o: Observation = {
    tick: 0,
    side: 0,
    credits: 10000,
    power: { total: 100, drain: 0, isLowPower: false },
    home: { x: 20, y: 20 },
    starts: [],
    products: [],
    queues: [],
    buildSites: [],
    own: [
      {
        ref: "tank",
        name: "MTNK",
        type: 7,
        x: 20,
        y: 20,
        hp: 300,
        maxHp: 300,
        width: 1,
        height: 1,
        mobile: true,
        idle: false,
        harvester: false,
        mcv: false,
        yard: false,
        refinery: false,
        combat: true,
        crusher: true,
        weaponRange: 5,
      },
    ],
    enemies: ["enemy-a", "enemy-b"].map((ref, i) => ({
      ref,
      name: "MTNK",
      type: 7,
      x: 24,
      y: 20 + i,
      hp: 300,
      maxHp: 300,
      observedTick: 0,
      weaponRange: 5,
    })),
  };
  const mission: CombatMission = {
    id: "duel",
    revision: 1,
    kind: "advance",
    units: ["tank"],
    destination: { x: 25, y: 20 },
    objective: "attack",
    engagement: { allowCrush: true },
  };
  assert(
    tactics
      .control(o, mission, [])
      .intents.some((i) => i.kind === "attack" && i.target === "enemy-a"),
  );
  o.tick = 15;
  target = "enemy-b";
  assert(
    tactics
      .control(o, mission, [])
      .intents.some((i) => i.kind === "attack" && i.target === "enemy-b"),
  );
  o.tick = 30;
  const armorContacts = o.enemies;
  o.enemies = [
    {
      ref: "infantry",
      name: "E1",
      type: 3,
      x: 22,
      y: 20,
      hp: 125,
      maxHp: 125,
      observedTick: 30,
      weaponRange: 4,
    },
  ];
  const defense = tactics.control(o, mission, []);
  assert.equal(calls, 2);
  assert(defense.intents.some((i) => i.kind === "crush"));
  o.tick = 45;
  o.enemies = armorContacts;
  tactics.control(o, mission, []);
  o.tick = 60;
  o.enemies = [
    {
      ref: "infantry",
      name: "E1",
      type: 3,
      x: 22,
      y: 20,
      hp: 125,
      maxHp: 125,
      observedTick: 60,
      weaponRange: 4,
    },
  ];
  assert(
    tactics.control(o, mission, []).intents.some((i) => i.kind === "crush"),
  );
});
