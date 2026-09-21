import type { Observation, Point, Unit } from "../model.js";
import type { ArmorState, OperationOrder } from "./armor-state.js";
import type { ControlReport } from "./contracts.js";
import type { LegacyArmorFrame } from "./legacy-armor.js";
import type { Operations } from "./operations.js";

export type OperationScope = "launch" | "operation";
export interface OperationAction {
  kind: "keep" | "apply";
  order?: OperationOrder;
  addRefs: readonly string[];
  expectedStateVersion: number;
}
export interface OperationAdvice {
  state: ArmorState;
  operations: Operations;
  recalled: readonly string[];
}
export interface OperationContext {
  observation: Observation;
  state: ArmorState;
  operations: Operations;
  reserve: readonly Unit[];
  anchors: {
    assemble: readonly Point[];
    defend: readonly Point[];
    withdraw: readonly Point[];
  };
  frame: LegacyArmorFrame;
  advice: OperationAdvice;
  delegatedChange?: {
    source: "fixed-rule";
    added: string[];
    released: string[];
    orderChanged: boolean;
  };
  feedback?: ControlReport;
}
export interface OperationProvider {
  readonly scope: OperationScope;
  readonly period: number;
  readonly teacher: boolean;
  /** Raw legacy teachers delegate execution; menu teachers use the policy executor. */
  readonly executionSource?: "policy" | "teacher";
  readonly record?: unknown;
  choose(context: OperationContext): OperationAction;
}
