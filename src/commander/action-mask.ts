import {
  roleMask,
  KEEP_UNIT,
  DEPLOY,
  TASK_SLOTS,
  type CommanderWorld,
} from "./world.js";
export type CommanderEncoding = "graph-plan-v1" | "graph-plan-v2";
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
