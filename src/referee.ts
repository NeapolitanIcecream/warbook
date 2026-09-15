import { ApiEventType, type Bot, type GameApi } from "@chronodivide/game-api";

/** Engine truth for diagnosis. This capability is never passed to Commander. */
export function recordDestruction(
  bot: Bot,
  api: GameApi,
  write: (record: unknown) => void,
): void {
  const known = new Map<number, { name: string; owner: string }>();
  const remember = (id: number) => {
    const unit = api.getUnitData(id);
    if (unit) known.set(id, { name: unit.name, owner: unit.owner });
  };
  api.getAllUnits().forEach(remember);
  bot.onGameEvent = (event) => {
    if (event.type === ApiEventType.ObjectSpawn) remember(event.target);
    if (event.type === ApiEventType.ObjectDestroy) {
      write({
        tick: api.getCurrentTick(),
        kind: "destroy",
        target: known.get(event.target),
        attacker: event.attackerInfo
          ? {
              ...event.attackerInfo,
              object:
                event.attackerInfo.objId === undefined
                  ? undefined
                  : known.get(event.attackerInfo.objId),
            }
          : undefined,
      });
      known.delete(event.target);
    }
  };
}
