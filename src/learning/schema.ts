/** Observation identifiers stay dependency-free: the rule-only bridge must not
 * pull the learner's random-number or tensor runtimes into frozen rule bots. */
export const OPERATION_SCHEMA = "operation-v2";
export const CONTACT_SCHEMA = "operation-contact-v1";
export const isOperationSchema = (schema: string) =>
  schema === OPERATION_SCHEMA || schema === CONTACT_SCHEMA;
