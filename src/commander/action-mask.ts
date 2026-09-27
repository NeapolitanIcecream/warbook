import {
  roleMask,
  KEEP_UNIT,
  DEPLOY,
  TASK_SLOTS,
  type CommanderWorld,
  type CommanderAction,
} from "./world.js";
export type CommanderEncoding =
  "graph-plan-v1" | "graph-plan-v2" | "graph-plan-v3" | "graph-plan-v4";
/** v4 keeps the v2 grammar and optionally changes production sampling only. */
export interface ProductionTemperatures {
  queue?: number;
  amount?: number;
  cash?: number;
}
export function resolveProductionTemperatures(
  encoding: CommanderEncoding,
  temperature: number,
  overrides?: ProductionTemperatures,
): Required<ProductionTemperatures> {
  if (!Number.isFinite(temperature) || temperature <= 0)
    throw new Error("Invalid commander temperature");
  const resolved = {
    queue: temperature,
    amount: temperature,
    cash: temperature,
  };
  if (overrides === undefined) return resolved;
  if (encoding !== "graph-plan-v4")
    throw new Error("Production temperatures require graph-plan-v4");
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
    throw new Error("Invalid production temperatures");
  for (const [key, value] of Object.entries(overrides)) {
    if (
      !Object.hasOwn(resolved, key) ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value <= 0
    )
      throw new Error("Invalid production temperature: " + key);
    resolved[key as keyof ProductionTemperatures] = value;
  }
  return resolved;
}
/** v3 records latent review decisions even when the reviewed domain keeps its plan. */
export type EncodedCommanderAction = CommanderAction & { edits?: number[] };
export function actionEdits(a: CommanderAction): number[] {
  return [
    a.queues.some((x) => x !== 0),
    a.kinds.some((x) => x !== 0),
    a.units.some((x) => x !== KEEP_UNIT),
    a.buildings.some((x) => x !== 0),
    a.placements.some((x) => x !== 0),
  ].map(Number);
}
/** A changed job needs explicit membership; unchanged membership has one spelling. */
export function commanderRoleMask(
  w: CommanderWorld,
  i: number,
  kinds: readonly number[],
  encoding: CommanderEncoding,
) {
  const mask = roleMask(w, i, kinds);
  if (encoding === "graph-plan-v1") return mask;
  const old = w.previousRoles[i];
  const retyped =
    old < TASK_SLOTS && kinds[old] !== 0 && kinds[old] !== w.previousKinds[old];
  if (retyped) mask[KEEP_UNIT] = false;
  if (mask[KEEP_UNIT] && old !== DEPLOY) mask[old] = false;
  return mask;
}
