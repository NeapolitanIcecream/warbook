import { Bot, cdapi, type GameInstanceApi } from "@chronodivide/game-api";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { WarbookBot } from "../src/bridge.js";
import { ProgramProduction } from "../src/control/program-production.js";
import { CommanderTactics } from "../src/commander/tactics.js";
import { distance2, type Point } from "../src/model.js";
import type {
  StrategicController,
  StrategicPlan,
  ProgramProductionPlan,
} from "../src/control/contracts.js";
const out = resolve(process.argv[2] ?? "runs/commander-miner-handoff");
mkdirSync(out, { recursive: true });
let phase = 0,
  since = 0,
  goal: Point | undefined,
  before = 0;
const orders: { tick: number; kind: string }[] = [];
const strategy: StrategicController = {
  id: "miner-handoff-probe",
  observationScope: "commander-v1",
  assessmentRequest: () => ({ unitType: "MTNK", factoryType: "GAWEAP" }),
  plan(o): StrategicPlan<ProgramProductionPlan> {
    const miner = o.own.find((u) => u.harvester),
      ready = o.own.filter((u) => u.type === 2 && u.buildStatus === 1);
    if (!goal && miner)
      goal = [...(o.oreFields ?? [])].sort(
        (a, b) => distance2(a, miner) - distance2(b, miner),
      )[0];
    if (phase === 0 && goal && miner) {
      phase = 1;
      since = o.tick;
    } else if (phase === 1 && miner && (miner.cargo ?? 0) > 0) {
      phase = 2;
      since = o.tick;
      before = miner.cargo ?? 0;
    } else if (phase === 2 && o.tick - since >= 30) {
      phase = 3;
      since = o.tick;
    } else if (phase === 3 && miner && (miner.cargo ?? 0) > before) phase = 4;
    const product = !ready.some((u) => u.name === "GAPOWR")
      ? "GAPOWR"
      : !ready.some((u) => u.refinery)
        ? "GAREFN"
        : undefined;
    return {
      tick: o.tick,
      combat: {
        id: "same-mining-slot",
        revision: phase,
        kind: phase === 2 ? "hold" : "harvest",
        units: miner ? [miner.ref] : [],
        destination: goal,
        objective: phase === 2 ? "explicit-hold" : "probe-harvest",
        engagement: { allowCrush: false },
      },
      production: {
        id: "setup",
        revision: 0,
        deploymentUnits: o.own.filter((u) => u.mcv).map((u) => u.ref),
        program: {
          queues: product
            ? [{ queue: 0, mode: "run", product, target: 1, reserve: 0 }]
            : [],
          placements: o.buildSites,
          repair: [],
          sell: [],
        },
      },
    };
  },
};
class Passive extends Bot {}
let game: GameInstanceApi | undefined;
try {
  await cdapi.init(resolve(process.env.MIX_DIR ?? "assets/ra2"));
  const actor = new WarbookBot("MinerProbe", "Americans", "bastion", {
    strategy,
    tactics: new CommanderTactics(),
    production: new ProgramProduction(),
  });
  actor.trace = (e) => {
    if (
      e.kind === "submitted" &&
      e.intent &&
      ["gather", "stop"].includes((e.intent as any).kind)
    )
      orders.push({ tick: e.tick, kind: (e.intent as any).kind });
  };
  game = await cdapi.createGame({
    mapName: "mp06t2.map",
    gameMode: 1,
    shortGame: false,
    mcvRepacks: true,
    cratesAppear: false,
    superWeapons: false,
    gameSpeed: 4,
    credits: 10000,
    unitCount: 0,
    buildOffAlly: false,
    agents: [actor, new Passive("Passive", "Americans")],
  });
  while (game.getCurrentTick() < 6000 && phase < 4) {
    if (game.getCurrentTick() % 3 === 0)
      actor.submit(actor.decide(actor.observe()));
    await game.update();
  }
  const result = {
    phase,
    tick: game.getCurrentTick(),
    orders,
    passed:
      phase === 4 &&
      orders.some(
        (o, i) =>
          o.kind === "stop" &&
          orders.slice(i + 1).some((x) => x.kind === "gather"),
      ),
    scope: "Real mining command/resumption probe; not a match win",
  };
  writeFileSync(out + "/report.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
} finally {
  game?.dispose();
}
