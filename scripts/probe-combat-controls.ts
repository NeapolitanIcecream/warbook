import { Bot, cdapi, OrderType } from "@chronodivide/game-api";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { WarbookBot } from "../src/bridge.js";

// A bounded live-engine action probe, not a competitive match or a strength test.
// Build normally from zero units; an idle opponent leaves its MCV at its start.
// All control uses the actor's own state, visible contacts and public map starts.
const root = resolve(process.argv[2] ?? "runs/combat-controls-probe");
if (existsSync(root) && readdirSync(root).length)
  throw new Error("Refusing to overwrite an existing probe");
mkdirSync(root, { recursive: true });
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
class Probe extends WarbookBot {
  tankId?: number;
  approachIssued = false;
  testTick?: number;
  testCommand?: unknown;
  targetId?: number;
  giId?: number;
  giDeployRequested?: number;
  giDeployedTick?: number;
  frames: any[] = [];
  constructor(
    country: string,
    readonly order: "Move" | "AttackMove" | "Attack",
  ) {
    super("Probe", country, "factory-exit");
  }
  step() {
    const o = this.observe();
    const own = this.player
      .getVisibleUnits("self")
      .map((id) => this.game.getUnitData(id)!)
      .filter(Boolean);
    const gi = own.find((u) => u.name === "E1");
    if (gi && this.giDeployRequested === undefined) {
      this.giId = gi.id;
      this.giDeployRequested = o.tick;
      this.player.actions.orderUnits([gi.id], OrderType.DeploySelected);
    }
    if (gi?.stance === 3 && this.giDeployedTick === undefined)
      this.giDeployedTick = o.tick;
    const tank = own.find((u) => u.name === "MTNK" || u.name === "HTNK");
    if (!tank) {
      this.submit(
        this.decide(o).filter((i) =>
          ["deploy", "queue", "place"].includes(i.kind),
        ),
      );
      return;
    }
    this.tankId = tank.id;
    const insideFactory = o.own.some(
      (b) =>
        ["GAWEAP", "NAWEAP"].includes(b.name) &&
        tank.tile.rx >= b.x &&
        tank.tile.rx < b.x + b.width &&
        tank.tile.ry >= b.y &&
        tank.tile.ry < b.y + b.height,
    );
    if (insideFactory) return;
    const enemies = this.player
      .getVisibleUnits("enemy")
      .map((id) => this.game.getUnitData(id)!)
      .filter(Boolean);
    const target = enemies.find((u) => ["AMCV", "SMCV"].includes(u.name));
    if (
      this.testTick === undefined &&
      target &&
      Math.hypot(
        target.tile.rx - tank.tile.rx,
        target.tile.ry - tank.tile.ry,
      ) <= 6
    ) {
      const dx = target.tile.rx - tank.tile.rx,
        dy = target.tile.ry - tank.tile.ry,
        length = Math.hypot(dx, dy) || 1;
      const x = Math.round(target.tile.rx + (12 * dx) / length),
        y = Math.round(target.tile.ry + (12 * dy) / length);
      if (!this.game.map.getTile(x, y))
        throw new Error("Probe destination outside map");
      this.testTick = o.tick;
      this.targetId = target.id;
      this.testCommand = {
        tick: o.tick,
        order: this.order,
        tank: {
          id: tank.id,
          name: tank.name,
          x: tank.tile.rx,
          y: tank.tile.ry,
          opportunityFire: tank.rules.opportunityFire,
        },
        target: { id: target.id, x: target.tile.rx, y: target.tile.ry },
        destination: { x, y },
      };
      if (this.order === "Attack")
        this.player.actions.orderUnits([tank.id], OrderType.Attack, target.id);
      else
        this.player.actions.orderUnits([tank.id], OrderType[this.order], x, y);
    } else if (!this.approachIssued && this.testTick === undefined) {
      const home = this.player.getPlayerData().startLocation;
      const other = this.game.map
        .getStartingLocations()
        .find((p) => p.x !== home.x || p.y !== home.y)!;
      this.player.actions.orderUnits(
        [tank.id],
        OrderType.Move,
        other.x,
        other.y,
      );
      this.approachIssued = true;
    }
  }
  sample() {
    if (this.testTick === undefined || this.tankId === undefined) return;
    const tank = this.game.getUnitData(this.tankId);
    if (!tank) return;
    const speed = tank.velocity?.length() ?? 0;
    const visibleTarget = this.player
      .getVisibleUnits("enemy")
      .includes(this.targetId!)
      ? this.game.getUnitData(this.targetId!)
      : undefined;
    this.frames.push({
      tick: this.game.getCurrentTick(),
      x: tank.tile.rx,
      y: tank.tile.ry,
      speed,
      attackState: tank.attackState,
      cooldown: tank.primaryWeapon?.cooldownTicks,
      hp: tank.hitPoints,
      weapon: tank.primaryWeapon?.rules.name,
      visibleTargetHp: visibleTarget?.hitPoints,
    });
  }
}
await cdapi.init(resolve(process.env.MIX_DIR ?? "assets/ra2"));
const results: unknown[] = [];
const source = {
  git: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: !!execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  }).trim(),
  scriptSha256: hash("scripts/probe-combat-controls.ts"),
  apiSha256: hash("node_modules/@chronodivide/game-api/dist/index.js"),
  resourceSha256: hash(
    "node_modules/@chronodivide/game-api/dist/res/ra2cd.mix",
  ),
  lockSha256: hash("package-lock.json"),
};
for (const country of ["Americans", "Russians"])
  for (const order of ["Move", "AttackMove", "Attack"] as const) {
    const directory = resolve(root, `${country}-${order}`);
    mkdirSync(directory, { recursive: true });
    const actor = new Probe(country, order),
      target = new Bot("Target", "Americans");
    const game = await cdapi.createGame({
      agents: [actor, target],
      mapName: "mp06t2.map",
      gameMode: cdapi.getAvailableGameModes("mp06t2.map")[0],
      shortGame: true,
      mcvRepacks: true,
      cratesAppear: false,
      superWeapons: false,
      gameSpeed: 5,
      credits: 10000,
      unitCount: 0,
      buildOffAlly: false,
    });
    try {
      const ruleNames = ["MTNK", "HTNK", "E1", "ADOG", "DOG", "GAPILL"];
      const rules = ruleNames.map((name) => {
        const collection = ["MTNK", "HTNK"].includes(name)
          ? game.gameApi.rules.vehicleRules
          : name === "GAPILL"
            ? game.gameApi.rules.buildingRules
            : game.gameApi.rules.infantryRules;
        const rule = collection.get(name);
        if (!rule) throw new Error(`Missing probe unit rules: ${name}`);
        return {
          name,
          speed: rule.speed,
          opportunityFire: rule.opportunityFire,
          deployer: rule.deployer,
          primary: rule.primary,
          secondary: rule.secondary,
        };
      });
      while (
        !game.isFinished() &&
        game.getCurrentTick() < 10000 &&
        (actor.testTick === undefined ||
          game.getCurrentTick() < actor.testTick + 600)
      ) {
        if (game.getCurrentTick() % 3 === 0) actor.step();
        await game.update();
        actor.sample();
      }
      const shots = actor.frames.filter(
        (f, i) =>
          i > 0 &&
          f.weapon === actor.frames[i - 1].weapon &&
          f.cooldown > actor.frames[i - 1].cooldown,
      );
      const movingSignals = shots.filter((s) => {
        const window = actor.frames.filter(
          (f) => Math.abs(f.tick - s.tick) <= 2,
        );
        return window.length === 5 && window.every((f) => f.speed > 1e-6);
      });
      const damageSignals = actor.frames.filter(
        (f, i) =>
          i > 0 &&
          f.visibleTargetHp !== undefined &&
          actor.frames[i - 1].visibleTargetHp !== undefined &&
          f.visibleTargetHp < actor.frames[i - 1].visibleTargetHp,
      );
      const result = {
        scope:
          "live action mechanism only; stationary MCV target; no strength or complete-game score",
        source,
        country,
        order,
        map: "mp06t2.map",
        rules,
        initialStarts: game
          .getPlayerStats()
          .map((p) => ({ name: p.name, start: p.startLocation })),
        command: actor.testCommand,
        gi: {
          id: actor.giId,
          requestedTick: actor.giDeployRequested,
          deployedTick: actor.giDeployedTick,
        },
        sampledTicks: actor.frames.length,
        cooldownRestarts: shots.length,
        restartsWithNonzeroVelocity: shots.filter((f) => f.speed > 1e-6).length,
        restartsWithFiveFramesOfMotion: movingSignals.map((f) => f.tick),
        visibleTargetHpDecreases: damageSignals.length,
        shots,
        frames: actor.frames,
        stopTick: game.getCurrentTick(),
        finished: game.isFinished(),
        replay: game.saveReplay(directory),
      };
      writeFileSync(`${directory}/probe.json`, JSON.stringify(result, null, 2));
      results.push({ ...result, frames: undefined });
      console.log(
        JSON.stringify({
          ...result,
          frames: undefined,
          rules: undefined,
          shots: undefined,
        }),
      );
    } finally {
      game.dispose();
    }
  }
writeFileSync(`${root}/summary.json`, JSON.stringify(results, null, 2));
