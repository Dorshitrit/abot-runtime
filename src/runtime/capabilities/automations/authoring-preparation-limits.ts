/** Shared admission bounds for preparation reads and their authoring receipts. */
export const AUTOMATION_AUTHORING_PREPARATION_LIMITS = {
  operationRefs: 16,
  outputBytes: 65_536,
} as const;
