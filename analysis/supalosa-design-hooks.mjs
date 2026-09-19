import { appendFileSync, writeFileSync } from "node:fs";
import { SupalosaBot } from "@supalosa/chronodivide-bot/dist/bot/bot.js";
import { MatchAwarenessImpl } from "@supalosa/chronodivide-bot/dist/bot/logic/awareness.js";
const output = process.env.SUPALOSA_AUDIT_PATH;
if (!output) throw new Error("SUPALOSA_AUDIT_PATH required");
let shouldAttackReads = 0,
  orders = 0,
  unitsOrdered = 0,
  repairRequests = 0;
const orderKinds = {};
const record = (e) => appendFileSync(output, JSON.stringify(e) + "\n");
const oldShouldAttack = MatchAwarenessImpl.prototype.shouldAttack;
MatchAwarenessImpl.prototype.shouldAttack = function (...args) {
  shouldAttackReads++;
  return oldShouldAttack.apply(this, args);
};
const start = SupalosaBot.prototype.onGameStart;
SupalosaBot.prototype.onGameStart = function (game) {
  this.logBotStatus = (message) => {
    if (
      /Added mission:|mission disbanded:|switching back to (attack|gather)|Decision \(|Pausing queue|Resuming queue/.test(
        message,
      )
    )
      record({ kind: "event", tick: game.getCurrentTick(), message });
  };
  start.call(this, game);
  const actions = this.context.player.actions;
  const order = actions.orderUnits.bind(actions);
  actions.orderUnits = (ids, type, ...target) => {
    orders++;
    unitsOrdered += ids.length;
    orderKinds[type] = (orderKinds[type] ?? 0) + 1;
    return order(ids, type, ...target);
  };
  const repair = actions.toggleRepairWrench.bind(actions);
  actions.toggleRepairWrench = (id) => {
    repairRequests++;
    record({
      kind: "repair",
      tick: game.getCurrentTick(),
      name: game.getUnitData(id)?.name,
    });
    return repair(id);
  };
};
const step = SupalosaBot.prototype.onGameTick;
SupalosaBot.prototype.onGameTick = function (game) {
  step.call(this, game);
  if (game.getCurrentTick() % 150 === 0) {
    const missions = this.missionController
      ?.getMissions()
      .map((m) => ({
        id: m.getUniqueName(),
        type: m.constructor.name,
        units: m.getUnitIds(),
        state: m.state,
        locked: m.isUnitsLocked(),
        priority: m.getPriority(),
        target: m.attackArea ?? m.defenceArea ?? m.scoutTarget ?? m.destination,
        squadState: m.squad?.state,
      }));
    const own = this.context.player
      .getVisibleUnits("self")
      .map((id) => game.getUnitData(id));
    const counts = {};
    for (const u of own) counts[u.name] = (counts[u.name] ?? 0) + 1;
    record({
      kind: "snapshot",
      tick: game.getCurrentTick(),
      credits: this.context.player.getPlayerData().credits,
      counts,
      missions,
    });
  }
};
process.on("exit", () =>
  writeFileSync(
    output + ".summary.json",
    JSON.stringify(
      { shouldAttackReads, orders, unitsOrdered, orderKinds, repairRequests },
      null,
      2,
    ),
  ),
);
