import type { OperationRecord } from "../src/learning/operation.js";
import {
  cdapi,
  Replay,
  ApiEventType,
  ObjectType,
  StanceType,
  ZoneType,
  type UnitData,
} from "@chronodivide/game-api";
import {
  createReadStream,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { fileHash } from "../src/bot-release.js";
import type { LaunchRecord } from "../src/learning/launch.js";
import {
  JournalBehavior,
  ReplayBehavior,
  isArmor,
  clockTime,
  renderBehavior,
  type ReplayUnit,
} from "../src/analysis/match-behavior.js";

async function main() {
  const started = performance.now();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      actor: { type: "string" },
      task: { type: "string" },
      window: { type: "string" },
    },
  });
  if (positionals.length !== 1)
    throw new Error(
      "Usage: encounter.ts <run directory> [--actor name] [--task task] [--window startTick:endTick]",
    );
  const directory = resolve(positionals[0]);
  const expected = JSON.parse(readFileSync(`${directory}/result.json`, "utf8"));
  const manifest = JSON.parse(
    readFileSync(`${directory}/manifest.json`, "utf8"),
  );
  const actor =
    values.actor ??
    manifest.participants.find((p: any) => p.role === "subject").name;
  const opponent = expected.stats.find((p: any) => p.name !== actor)?.name;
  if (!opponent || !expected.stats.some((p: any) => p.name === actor))
    throw new Error("Actor not in recorded roster");
  if (fileHash(expected.replay.file) !== expected.replay.sha256)
    throw new Error("Replay hash mismatch");
  const window = values.window?.split(":").map(Number);
  if (
    window &&
    (window.length !== 2 ||
      window.some((n) => !Number.isInteger(n) || n < 0) ||
      window[1] < window[0] ||
      window[1] > expected.tick)
  )
    throw new Error(
      "Window must be startTick:endTick within the recorded match",
    );

  type Shape = { name: string; x: number; y: number; hp: number };
  const signature = (u: Shape) => JSON.stringify([u.name, u.x, u.y, u.hp]);
  const signatures = (units: Shape[]) => units.map(signature).sort().join("|");
  const shape = (u: UnitData): Shape => ({
    name: u.name,
    x: u.tile.rx,
    y: u.tile.ry,
    hp: u.hitPoints,
  });
  const sparse = new Map<
    number,
    { actor: string; own: string; enemy: string }[]
  >();
  const journal = new JournalBehavior();
  const launches: { tick: number; units: number; target: string }[] = [];
  const operationSummary = {
    records: 0,
    choices: 0,
    scope: undefined as OperationRecord["scope"] | undefined,
    startedForces: 0,
    reinforcementOrders: 0,
    teacherRecords: 0,
    menuTeacherRecords: 0,
    clearedRetargets: 0,
    liveRetargets: 0,
    firstCommit: undefined as { tick: number; members: number } | undefined,
    firstWithdrawal: undefined as
      { tick: number; members: number; meanHealth: number } | undefined,
    appliedByKind: {} as Record<string, number>,
    teacherCoverage: {} as Record<string, number>,
  };
  let launchRecords = 0;
  let launchChoices = 0;
  let lastTick = -1;
  const rawTrace = `${directory}/decisions.ndjson`;
  const compressed = !existsSync(rawTrace);
  const tracePath = compressed ? rawTrace + ".gz" : rawTrace;
  const traceStream = createReadStream(tracePath);
  for await (const line of createInterface({
    input: compressed ? traceStream.pipe(createGunzip()) : traceStream,
    crlfDelay: Infinity,
  })) {
    const event = JSON.parse(line);
    if (event.tick < lastTick || event.tick > expected.tick)
      throw new Error("Journal ticks inconsistent with recorded match");
    lastTick = event.tick;
    if (event.kind === "observation") {
      const list = sparse.get(event.tick) ?? [];
      list.push({
        actor: event.actor,
        own: signatures(event.observation.own),
        enemy: signatures(event.observation.enemies),
      });
      sparse.set(event.tick, list);
    }
    if (event.actor !== actor) continue;
    if (event.kind === "operation_decision") {
      const r = event.record as OperationRecord;
      operationSummary.records++;
      operationSummary.scope = r.scope;
      if (r.executionSource === "teacher") operationSummary.teacherRecords++;
      if (r.policy === "teacher-menu") operationSummary.menuTeacherRecords++;
      if (r.trainable) operationSummary.choices++;
      operationSummary.teacherCoverage[r.teacherCoverage] =
        (operationSummary.teacherCoverage[r.teacherCoverage] ?? 0) + 1;
      if (
        r.action > 0 &&
        (r.executionSource === "policy" || r.policy === "teacher-menu")
      ) {
        const a = r.actions[r.action],
          kind = a.order?.kind ?? r.operation.kind ?? "unknown";
        operationSummary.appliedByKind[kind] =
          (operationSummary.appliedByKind[kind] ?? 0) + 1;
        if (r.scope === "launch" || !r.operation.members) {
          operationSummary.startedForces++;
          operationSummary.firstCommit ??= {
            tick: r.tick,
            members: a.addRefs.length,
          };
        } else if (a.addRefs.length) operationSummary.reinforcementOrders++;
        if (r.operation.kind === "advance" && a.order?.kind === "advance") {
          if (r.operation.cleared) operationSummary.clearedRetargets++;
          else operationSummary.liveRetargets++;
        }
        if (
          r.operation.members &&
          r.operation.kind !== "withdraw" &&
          a.order?.kind === "withdraw"
        )
          operationSummary.firstWithdrawal ??= {
            tick: r.tick,
            members: r.operation.members,
            // The KEEP row describes the existing force, before any joint recruits.
            meanHealth: r.candidates[0][20],
          };
      }
    }
    if (event.kind === "launch_decision") {
      const record = event.record as LaunchRecord;
      launchRecords++;
      if (record.trainable) launchChoices++;
      if (record.action > 0) {
        const action = record.actions[record.action];
        launches.push({
          tick: event.tick,
          units: action.units.length,
          target: record.targets[action.target!].kind,
        });
      }
    }
    if (event.kind === "strategic_plan") journal.onPlan(event.plan);
    if (event.kind === "base_contact")
      journal.onContact(event.tick, event.contacts);
    if (event.kind === "control_report")
      journal.onDecision(event.report.combat.facts);
    if (event.kind === "submitted")
      journal.onOrder(event.tick, event.intent, event.origin?.id);
    if (event.kind === "observation") journal.onObservation(event.observation);
  }
  const journalSummary = journal.finish();
  const snapshotCount = [...sparse.values()].reduce(
    (n, rows) => n + rows.length,
    0,
  );
  const unit = (u: UnitData): ReplayUnit => {
    const selected =
      u.stance === StanceType.Deployed
        ? (u.secondaryWeapon ?? u.primaryWeapon)
        : u.primaryWeapon;
    const weapons = [
      ...new Map(
        [u.primaryWeapon, u.secondaryWeapon]
          .filter(Boolean)
          .map((w) => [
            w!.rules.name,
            { name: w!.rules.name, cooldown: w!.cooldownTicks },
          ]),
      ).values(),
    ];
    return {
      ...shape(u),
      id: u.id,
      building: u.type === ObjectType.Building,
      defense: u.rules.isBaseDefense,
      infantry: u.type === ObjectType.Infantry,
      armor: isArmor(u.name),
      combat: u.rules.isSelectableCombatant && weapons.length > 0,
      airborne: u.zone === ZoneType.Air,
      deployed: u.stance === StanceType.Deployed,
      range: selected?.projectileRules.isAntiGround ? selected.maxRange : 0,
      width: u.foundation.width,
      height: u.foundation.height,
      weapons,
    };
  };
  await cdapi.init(resolve(process.env.MIX_DIR ?? "assets/ra2"));
  const game = await cdapi.loadReplay(
    Replay.parse(readFileSync(expected.replay.file, "utf8")),
  );
  const behavior = new ReplayBehavior();
  const known = new Map<
    number,
    {
      owner: string;
      building: boolean;
      defense: boolean;
      id: number;
      name: string;
    }
  >();
  const remember = (id: number) => {
    const object = game.gameApi.getGameObjectData(id);
    if (
      !object ||
      ![
        ObjectType.Building,
        ObjectType.Infantry,
        ObjectType.Vehicle,
        ObjectType.Aircraft,
      ].includes(object.type)
    )
      return;
    const u = game.gameApi.getUnitData(id);
    if (u)
      known.set(id, {
        id,
        name: u.name,
        owner: u.owner,
        building: u.type === ObjectType.Building,
        defense: u.rules.isBaseDefense,
      });
  };
  game.gameApi.getAllUnits().forEach(remember);
  const unsubscribe = game.eventsApi.subscribe((event) => {
    if (event.type === ApiEventType.ObjectSpawn) remember(event.target);
    if (event.type === ApiEventType.ObjectOwnerChange) {
      const u = known.get(event.target);
      if (u) u.owner = event.newOwnerName;
    }
    if (event.type === ApiEventType.ObjectDestroy) {
      const u = known.get(event.target);
      if (u && [actor, opponent].includes(u.owner))
        behavior.destroyed(
          u.owner === actor ? "own" : "opponent",
          u,
          game.getCurrentTick(),
        );
      known.delete(event.target);
    }
  });
  const mismatches: unknown[] = [],
    frames: string[] = [];
  let checked = 0,
    sampled = 0,
    previousSample = -1;
  try {
    while (performance.now() - started < 120000) {
      const tick = game.getCurrentTick();
      if (tick % 3 === 0 && tick !== previousSample) {
        previousSample = tick;
        sampled++;
        const cache = new Map<number, UnitData>();
        const units = (name: string, type: "self" | "enemy") =>
          game
            .getPlayer(name)
            .getVisibleUnits(type)
            .map((id) => {
              if (!cache.has(id)) cache.set(id, game.gameApi.getUnitData(id)!);
              return cache.get(id)!;
            });
        for (const row of sparse.get(tick) ?? []) {
          checked++;
          const ownMatches =
            signatures(units(row.actor, "self").map(shape)) === row.own;
          const enemyMatches =
            signatures(units(row.actor, "enemy").map(shape)) === row.enemy;
          if (!ownMatches || !enemyMatches)
            mismatches.push({
              tick,
              actor: row.actor,
              ownMatches,
              enemyMatches,
            });
        }
        const frame = {
          tick,
          own: units(actor, "self").map(unit),
          opponent: units(opponent, "self").map(unit),
          visibleEnemyIds: units(actor, "enemy").map((u) => u.id),
        };
        behavior.sample(frame);
        if (window && tick >= window[0] && tick <= window[1])
          frames.push(JSON.stringify(frame));
      }
      // A runner-limit recording ends at its saved tick, not at a fabricated Game.onEnd.
      if (tick >= expected.tick || game.isFinished()) break;
      await game.update();
    }
    const players = expected.stats.map((p: any) => ({
      name: p.name,
      defeated: game.getPlayer(p.name).isDefeated(),
      credits: game.getPlayer(p.name).getPlayerData().credits,
    }));
    const recordedStopMatched =
      game.getCurrentTick() === expected.tick &&
      (!expected.cleanCompletionVerified || game.isFinished()) &&
      players.every((p: any) =>
        expected.stats.some(
          (e: any) =>
            e.name === p.name &&
            e.defeated === p.defeated &&
            e.credits === p.credits,
        ),
      );
    const verified =
      recordedStopMatched &&
      checked === snapshotCount &&
      mismatches.length === 0;
    const finalOwn = game
      .getPlayer(actor)
      .getVisibleUnits("self")
      .map((id) => unit(game.gameApi.getUnitData(id)!));
    const result = behavior.finish(journalSummary, finalOwn);
    const source = {
      directory,
      actor,
      opponent,
      replaySha256: expected.replay.sha256,
      analyzerSha256: fileHash(fileURLToPath(import.meta.url)),
      behaviorRulesSha256: fileHash("src/analysis/match-behavior.ts"),
      signalRulesSha256: fileHash("src/analysis/combat-signals.ts"),
      policyReleases: manifest.participants.map((p: any) => ({
        name: p.name,
        mode: p.release?.mode,
        git: p.release?.git,
        sha256: p.release?.sha256,
      })),
    };
    const report = {
      format: "warbook-match-behavior-v1",
      source,
      scope:
        "Recorded plans, submitted orders and observed replay behavior are separate. Offline opponent-owned state is diagnostic only; no counterfactual or actor changes.",
      stop: {
        reason: expected.stopReason,
        tick: expected.tick,
        outcome: expected.outcome,
        cleanCompletionVerified: expected.cleanCompletionVerified,
      },
      verification: {
        verified,
        recordedStopMatched,
        tick: game.getCurrentTick(),
        players,
        snapshotsExpected: snapshotCount,
        snapshotsChecked: checked,
        mismatches,
      },
      behavior: verified ? result : undefined,
      operationDecisions: operationSummary.records
        ? operationSummary
        : undefined,
      launchDecisions: launchRecords
        ? { records: launchRecords, choices: launchChoices, launches }
        : undefined,
      task: values.task
        ? { name: values.task, ...journal.taskOrders.get(values.task) }
        : undefined,
      definitions: {
        sampleTicks: 3,
        journalStallMinimumTicks: 900,
        journalStallPositionTolerance: 1,
        journalMaximumSampleGap: 300,
        homeRadius: 12,
        defenseMinimumDamageSpanTicks: 150,
        defenseIncludesShortBuildingLosses: true,
        defenseWindowTicks: 450,
        firingWindowTicks: 30,
        fire: "Same-weapon cooldown increases; signals consistent with firing, not exact shot/hit attribution. Both primary and secondary weapons are checked.",
        range:
          "Tile geometry only; does not establish line of sight or actual fire.",
        damage:
          "Observed HP decreases and destroy events, not attacker-attributed damage or a new scoring rule.",
      },
      cost: {
        wallSeconds: (performance.now() - started) / 1000,
        sampledFrames: sampled,
        retainedFrames: frames.length,
        windowBytes: frames.reduce((n, f) => n + Buffer.byteLength(f) + 1, 0),
        originalTraceBytes: compressed
          ? JSON.parse(readFileSync(rawTrace + ".archive.json", "utf8"))
              .originalBytes
          : statSync(tracePath).size,
        storedTraceBytes: statSync(tracePath).size,
      },
    };
    writeFileSync(
      `${directory}/encounter.json`,
      JSON.stringify(report, null, 2) + "\n",
    );
    if (!verified)
      throw new Error(
        `Replay validation failed; inspect ${directory}/encounter.json`,
      );
    const lines = [
      "# 对局行为检查",
      "",
      `${actor} 对 ${opponent}；记录到 ${clockTime(expected.tick)}，${expected.stopReason}，${JSON.stringify(expected.outcome)}。`,
      "",
      ...(operationSummary.records
        ? [
            operationSummary.teacherRecords === operationSummary.records &&
            !operationSummary.menuTeacherRecords
              ? `- 规则教师：${operationSummary.records} 个记录时点；候选覆盖 ${JSON.stringify(operationSummary.teacherCoverage)}。实际执行旧规则，未表示的动作不计作模型 KEEP。`
              : `- ${operationSummary.menuTeacherRecords ? "菜单教师实际选择" : "模型作战选择"}：${operationSummary.choices}/${operationSummary.records} 个时点有选择；${operationSummary.startedForces} 次建立编组、${operationSummary.reinforcementOrders} 次补兵；模型命令 ${JSON.stringify(operationSummary.appliedByKind)}。${operationSummary.firstCommit ? `首次 ${clockTime(operationSummary.firstCommit.tick)} 授权 ${operationSummary.firstCommit.members} 单位。` : ""}此前部队仍可执行固定任务；${operationSummary.scope === "launch" ? "持续作战由固定规则管理" : "KEEP 延续现有命令"}。`,
            ...(operationSummary.teacherRecords === operationSummary.records &&
            !operationSummary.menuTeacherRecords
              ? []
              : [
                  `- 任务变化：${operationSummary.clearedRetargets} 次在目标清空后改派、${operationSummary.liveRetargets} 次在未清空时换进攻目标。${operationSummary.firstWithdrawal ? `首次切换撤回 ${clockTime(operationSummary.firstWithdrawal.tick)}，当时既有编组 ${operationSummary.firstWithdrawal.members} 单位、平均血量 ${Math.round(operationSummary.firstWithdrawal.meanHealth * 100)}%。` : "未选择撤回已有编组。"}命令变化不等于实际到达或开火。`,
                ]),
          ]
        : []),
      ...(launchRecords
        ? [
            `- 学习出击选择：${launchChoices} 个可选择时点，${launches.length} 次选择出击。${launches.length ? `首次 ${clockTime(launches[0].tick)}，${launches[0].units} 单位，目标 ${launches[0].target}；最后 ${clockTime(launches.at(-1)!.tick)}。` : "没有选择出击。"}这是策略选择，不等于已抵达或开火。`,
          ]
        : []),
      renderBehavior(result),
      "",
      `核对：${checked}/${snapshotCount} 份原单位快照、停止 tick、资金及败北状态一致。原始回放和版本见 encounter.json。`,
      "开火为武器冷却重启信号，几何射程不代表实际开火；HP 下降未做攻击者归因。超时记录不计正常败局。",
      "",
    ];
    if (values.task)
      lines.push(
        `指定任务 ${values.task}：${journal.taskOrders.get(values.task)?.count ?? 0} 条已提交命令。`,
        "",
      );
    if (window) {
      writeFileSync(
        `${directory}/encounter-window.ndjson`,
        frames.join("\n") + "\n",
      );
      lines.push(
        `所选 ${values.window} tick 窗口保留 ${frames.length} 帧，见 encounter-window.ndjson。`,
        "",
      );
    }
    writeFileSync(`${directory}/encounter.md`, lines.join("\n"));
    console.log(lines.join("\n"));
  } finally {
    unsubscribe();
    game.dispose();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
