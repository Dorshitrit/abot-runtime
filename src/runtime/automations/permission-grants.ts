import { randomUUID } from "node:crypto";
import { requireUnarchivedAutomation } from "./archive-management.js";
import type { SchedulerToolPermissionMode } from "../scheduler/tool-permission-mode.js";
import type { OperationRef } from "./definition-contracts.js";
import type { AutomationPersistence } from "./persistence.js";
import type { AutomationGrantRecord } from "./storage-records.js";

export function sameOperation(left: OperationRef, right: OperationRef): boolean {
  return left.toolName === right.toolName &&
    left.operationId === right.operationId &&
    left.contractVersion === right.contractVersion;
}

export type GrantableAutomationOperation = Readonly<{
  operation: OperationRef;
  requiredMode: SchedulerToolPermissionMode;
}>;

function operationKey(ref: OperationRef): string {
  return `${ref.toolName}\u0000${ref.operationId}\u0000${ref.contractVersion}`;
}

export function currentAutomationGrant(
  records: readonly AutomationGrantRecord[],
  environmentId: string,
  automationId: string,
): AutomationGrantRecord | null {
  return records
    .filter((item) => item.environmentId === environmentId && item.automationId === automationId)
    .reduce<AutomationGrantRecord | null>((latest, item) =>
      !latest || item.grantRevision > latest.grantRevision ? item : latest, null);
}

export function permitsAutomationOperation(
  grant: AutomationGrantRecord | null,
  environmentId: string,
  automationId: string,
  selected: OperationRef,
  requiredMode: SchedulerToolPermissionMode,
): boolean {
  if (!grant || grant.environmentId !== environmentId || grant.automationId !== automationId)
    return false;
  if (requiredMode === "full_plus" && grant.mode !== "full_plus") return false;
  return grant.operations.some((operation) => sameOperation(operation, selected));
}

export function createAutomationGrantManager(options: {
  persistence: AutomationPersistence;
  environmentId: string;
  availableOperations: () => Promise<readonly GrantableAutomationOperation[]>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;

  async function get(automationId: string): Promise<AutomationGrantRecord | null> {
    const state = await options.persistence.read();
    return currentAutomationGrant(state.grants, options.environmentId, automationId);
  }

  async function replace(input: {
    automationId: string;
    expectedGrantRevision: number;
    mode: SchedulerToolPermissionMode;
    operations: readonly OperationRef[];
    actionId: string;
  }): Promise<AutomationGrantRecord> {
    if (!Number.isSafeInteger(input.expectedGrantRevision) || input.expectedGrantRevision < 0)
      throw new Error("automation_grant_revision_conflict");
    if (input.mode !== "full_access" && input.mode !== "full_plus")
      throw new Error("automation_grant_invalid");
    if (!input.actionId || input.actionId.length > 128 || input.operations.length > 64)
      throw new Error("automation_grant_invalid");
    const available = await options.availableOperations();
    const keys = new Set<string>();
    for (const operation of input.operations) {
      const key = operationKey(operation);
      const current = available.find((candidate) => sameOperation(candidate.operation, operation));
      if (keys.has(key) || !current)
        throw new Error("automation_operation_unavailable");
      if (current.requiredMode === "full_plus" && input.mode !== "full_plus")
        throw new Error("automation_grant_invalid");
      keys.add(key);
    }
    return options.persistence.update((state) => {
      if (!state.drafts.some((item) => item.automationId === input.automationId))
        throw new Error("automation_not_found");
      requireUnarchivedAutomation(state, input.automationId);
      const previous = currentAutomationGrant(
        state.grants, options.environmentId, input.automationId,
      );
      if ((previous?.grantRevision ?? 0) !== input.expectedGrantRevision)
        throw new Error("automation_grant_revision_conflict");
      const grant: AutomationGrantRecord = {
        id: randomUUID(),
        automationId: input.automationId,
        environmentId: options.environmentId,
        grantRevision: input.expectedGrantRevision + 1,
        mode: input.mode,
        operations: structuredClone(input.operations),
        evidence: {
          kind: "authenticated_user_action",
          actionId: input.actionId,
          at: new Date(now()).toISOString(),
        },
      };
      state.grants.push(grant);
      return grant;
    });
  }

  return { get, replace };
}

export type AutomationGrantManager = ReturnType<typeof createAutomationGrantManager>;
