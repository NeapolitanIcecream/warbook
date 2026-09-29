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
export type MemberScoring =
  | { mode: "separate-v1" }
  | { mode: "current-task-keep-v1" }
  | { mode: "keep-bias-v1"; bias: number };

export function resolveMemberScoring(
  encoding: CommanderEncoding,
  raw?: unknown,
): MemberScoring {
  if (raw === undefined) return { mode: "separate-v1" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid member scoring");
  const value = raw as Record<string, unknown>;
  if (
    !Object.hasOwn(value, "mode") ||
    !["separate-v1", "current-task-keep-v1", "keep-bias-v1"].includes(
      value.mode as string,
    ) ||
    Reflect.ownKeys(value).some(
      (key) =>
        key !== "mode" && !(value.mode === "keep-bias-v1" && key === "bias"),
    )
  )
    throw new Error("Invalid member scoring fields");
  if (value.mode !== "separate-v1" && encoding !== "graph-plan-v4")
    throw new Error("Member scoring experiment requires graph-plan-v4");
  if (value.mode === "keep-bias-v1") {
    if (
      !Object.hasOwn(value, "bias") ||
      typeof value.bias !== "number" ||
      !Number.isFinite(value.bias) ||
      value.bias < 0
    )
      throw new Error("Invalid member scoring bias");
    return { mode: value.mode, bias: value.bias };
  }
  return { mode: value.mode as "separate-v1" | "current-task-keep-v1" };
}

/** Header-only transport boundary: old Node and Python loaders must reject M/I. */
export function commanderArtifactEncoding(
  artifact: unknown,
): CommanderEncoding {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact))
    throw new Error("Invalid commander artifact header");
  const header = artifact as Record<string, unknown>;
  if (header.format === "warbook-commander-model-v1") {
    if (
      !Object.hasOwn(header, "encoding") ||
      Object.hasOwn(header, "actionEncoding") ||
      ![
        "graph-plan-v1",
        "graph-plan-v2",
        "graph-plan-v3",
        "graph-plan-v4",
      ].includes(header.encoding as string)
    )
      throw new Error(
        "Commander v1 artifact requires encoding and no actionEncoding",
      );
    const encoding = header.encoding as CommanderEncoding;
    if (
      resolveMemberScoring(encoding, header.memberScoring).mode !==
      "separate-v1"
    )
      throw new Error(
        "Experimental member scoring requires a v2 commander artifact",
      );
    return encoding;
  }
  if (header.format === "warbook-commander-model-v2") {
    if (
      Object.hasOwn(header, "encoding") ||
      !Object.hasOwn(header, "actionEncoding") ||
      header.actionEncoding !== "graph-plan-v4" ||
      !Object.hasOwn(header, "memberScoring")
    )
      throw new Error(
        "Commander v2 artifact requires actionEncoding graph-plan-v4, explicit memberScoring and no encoding",
      );
    if (
      resolveMemberScoring("graph-plan-v4", header.memberScoring).mode ===
      "separate-v1"
    )
      throw new Error(
        "Commander v2 artifact requires explicit experimental member scoring",
      );
    return "graph-plan-v4";
  }
  throw new Error("Unsupported commander artifact format");
}
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

/** The original mask supplies compatibility; no task edit may bypass it. */
export function memberKeepEligible(
  w: CommanderWorld,
  i: number,
  kinds: readonly number[],
  originalMask: readonly boolean[],
): boolean {
  if (!Number.isInteger(i) || i < 0 || i >= w.unitRefs.length) return false;
  const old = w.previousRoles[i];
  if (!Number.isInteger(old) || old < 0 || old >= TASK_SLOTS) return false;
  const before = w.previousKinds[old],
    after = kinds[old] === 0 ? before : kinds[old];
  return (
    before >= 2 &&
    after === before &&
    originalMask[KEEP_UNIT] === true &&
    originalMask[old] === false
  );
}
