export interface CombatSample {
  tick: number;
  id: number;
  hp: number;
  weapon?: string;
  cooldown?: number;
}

/** Consecutive samples support intervals, not exact hit/fire attribution. */
export function combatSignals(
  previous: CombatSample | undefined,
  current: CombatSample,
  interval = 3,
) {
  if (
    !previous ||
    previous.id !== current.id ||
    current.tick - previous.tick !== interval
  )
    return {};
  return {
    damage:
      current.hp < previous.hp
        ? {
            fromTick: previous.tick,
            tick: current.tick,
            hpBefore: previous.hp,
            hpAfter: current.hp,
          }
        : undefined,
    cooldownRestart:
      current.weapon !== undefined &&
      current.weapon === previous.weapon &&
      current.cooldown !== undefined &&
      previous.cooldown !== undefined &&
      current.cooldown > previous.cooldown
        ? {
            fromTick: previous.tick,
            tick: current.tick,
            weapon: current.weapon,
          }
        : undefined,
  };
}
