import { distance2, type Intent, type Unit } from "../model.js";

/** Keep native tasks running. Retry the same request only after observable idleness;
 * a timer alone is not evidence that a still-running engine task needs replacing. */
export class NativeOrders {
  private sent = new Map<string, { key: string; tick: number; deploy: boolean }>();

  forget(ref: string) { this.sent.delete(ref); }

  allow(unit: Unit, intent: Intent, tick: number, interval = 30, urgent = false): boolean {
    const { task: _task, ...action } = intent;
    const key = JSON.stringify({
      ...action,
      ...("refs" in action ? { refs: undefined } : {}),
      ...(intent.kind === "deploy" ? { deployed: !unit.deployed } : {}),
    });
    const old = this.sent.get(unit.ref);
    const completedMove =
      (intent.kind === "move" || intent.kind === "attackMove") &&
      distance2(unit, intent) <= 1 &&
      Boolean(unit.onBridge) === Boolean(intent.onBridge);
    const idleRetry = unit.idle && (unit.attackState ?? 0) < 3 && intent.kind !== "stop" && !completedMove &&
      tick - (old?.tick ?? -Infinity) >= (intent.kind === "deploy" ? 90 : 180);
    if (old && (old.key === key ? !idleRetry :
      !urgent && !old.deploy && tick - old.tick < interval)) return false;
    this.sent.set(unit.ref, { key, tick, deploy: intent.kind === "deploy" });
    return true;
  }
}
