import type {
  RegisteredToolNormalInvocation,
  ToolAvailabilityEntry,
} from "../../capabilities/tool-types.js";

/** Passive request-effective tool facts, independent of execution services. */
export interface ToolAvailabilitySource {
  getAvailableTools(): readonly ToolAvailabilityEntry[] | undefined;
}

export function projectAvailableTools(
  registrations: readonly RegisteredToolNormalInvocation[] | undefined,
): readonly ToolAvailabilityEntry[] | undefined {
  if (registrations === undefined) return undefined;

  const entries = registrations.flatMap((registration) =>
    registration.contract.operations.map((operation) =>
      Object.freeze({
        toolName: registration.toolName,
        operationId: operation.operationId,
        summary: operation.summary,
        catalogGroups: Object.freeze([
          ...(registration.definition.catalogGroups ?? ["other"]),
        ]),
        effect: operation.effect,
      }),
    ),
  );
  entries.sort(compareAvailableTools);
  return Object.freeze(entries);
}

function compareAvailableTools(
  left: ToolAvailabilityEntry,
  right: ToolAvailabilityEntry,
): number {
  const byOperation = compareAscii(left.operationId, right.operationId);
  return byOperation !== 0
    ? byOperation
    : compareAscii(left.toolName, right.toolName);
}

function compareAscii(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
