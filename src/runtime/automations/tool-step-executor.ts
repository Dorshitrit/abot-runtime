import { randomUUID } from "node:crypto";
import type { RegisteredToolNormalInvocation, ToolRequestAttachment, ToolUnderlyingSettlement } from "../../capabilities/tool-types.js";
import type { ToolRegistry } from "../ports.js";
import { createRegisteredToolNormalInvocationExecutor } from "../adapters/registered-tool-normal-invocations/executor.js";
import { bindRequestToolRegistry } from "../capabilities/request-bound-tool-registry.js";
import { restrictToolRegistryToRequestMode } from "../capabilities/request-permission-tool-registry.js";
import type { OperationRef, ToolNode } from "./definition-contracts.js";
import { permitsAutomationOperation, sameOperation } from "./permission-grants.js";
import type { AutomationGrantRecord } from "./storage-records.js";
import {
  classifyAutomationToolDispatchFailure, projectAutomationToolStepOutcome,
  type AutomationToolStepOutcome,
} from "./tool-step-outcome.js";
export type { AutomationToolStepOutcome } from "./tool-step-outcome.js";

function selectedRegistration(
  registrations: readonly RegisteredToolNormalInvocation[],
  selected: OperationRef,
): RegisteredToolNormalInvocation | null {
  const owner = registrations.find((registration) =>
    registration.toolName === selected.toolName &&
    registration.contract.version === selected.contractVersion &&
    registration.contract.operations.some((operation) => operation.operationId === selected.operationId));
  if (!owner) return null;
  const operation = owner.contract.operations.find((item) => item.operationId === selected.operationId)!;
  return { ...owner, contract: { ...owner.contract, operations: [operation] } };
}

function rejectsModelContext() {
  let requested = false;
  return {
    modelInvoker: {
      async invokeText(): Promise<string> {
        requested = true;
        throw new Error("automation_tool_model_context_missing");
      },
    },
    wasRequested: () => requested,
  };
}

function permittedByLatestGrant(
  latest: AutomationGrantRecord | null,
  captured: AutomationGrantRecord,
  environmentId: string,
  automationId: string,
  operation: OperationRef,
  requiredMode: "full_access" | "full_plus",
): boolean {
  if (!latest || latest.grantRevision !== captured.grantRevision) return false;
  return permitsAutomationOperation(latest, environmentId, automationId, operation, requiredMode);
}

/** One normal-invocation operation; attempts and receipts are durable callbacks. */
export async function executeAutomationToolStep(input: {
  node: ToolNode;
  controls: Readonly<Record<string, unknown>>;
  sourceAttachments?: readonly ToolRequestAttachment[];
  payload?: string;
  registry: ToolRegistry;
  environmentId: string;
  automationId: string;
  capturedGrant: AutomationGrantRecord;
  currentGrant(): Promise<AutomationGrantRecord | null>;
  workingDirectory?: string;
  requestId: string;
  abortSignal: AbortSignal;
  onUnderlyingSettlement?: (invocationId: string, settled: Promise<ToolUnderlyingSettlement>) => void;
  invokeTool?: <T>(invoke: () => Promise<T>) => Promise<T>;
  holdEffectAdmission?: () => () => void;
  beforeEffect(attempt: Readonly<{ invocationId: string; fingerprint: string }>): Promise<void>;
  afterEffect(
    attempt: Readonly<{ invocationId: string; fingerprint: string }>,
    outcome: AutomationToolStepOutcome,
    notDispatched: boolean,
  ): Promise<void>;
}): Promise<AutomationToolStepOutcome> {
  const requested = input.node.operation;
  if (!permitsAutomationOperation(
    input.capturedGrant, input.environmentId, input.automationId,
    requested, input.capturedGrant.mode,
  )) return { kind: "rejected", code: "automation_operation_unavailable", message: "This operation is not granted to the automation." };
  const preparedRegistry = await input.registry.prepareRequest?.() ?? input.registry;
  const available = restrictToolRegistryToRequestMode(preparedRegistry, input.capturedGrant.mode);
  const registered = selectedRegistration(available.listNormalInvocations?.() ?? [], requested);
  if (!registered) return { kind: "rejected", code: "automation_operation_unavailable", message: "The operation is no longer configured." };
  const requiredMode = registered.definition.requiredPermissionMode ?? "full_access";
  if (!permittedByLatestGrant(
    await input.currentGrant(), input.capturedGrant, input.environmentId,
    input.automationId, requested, requiredMode,
  )) return { kind: "rejected", code: "automation_operation_unavailable", message: "The automation permission changed." };

  const noModel = rejectsModelContext();
  let activeInvocationId: string | undefined;
  let dispatched = false;
  const observedRegistry: ToolRegistry = {
    ...available,
    execute: (call, options) => {
      const invoke = () => {
        dispatched = true;
        return available.execute(call, {
          ...options,
          onUnderlyingSettlement: (settled) => {
            if (activeInvocationId) input.onUnderlyingSettlement?.(activeInvocationId, settled);
          },
        });
      };
      if (input.invokeTool) return input.invokeTool(invoke);
      input.abortSignal.throwIfAborted();
      return invoke();
    },
  };
  const boundRegistry = bindRequestToolRegistry({
    registry: observedRegistry,
    modelInvoker: noModel.modelInvoker,
    ...(input.sourceAttachments?.length ? { requestAttachments: input.sourceAttachments } : {}),
    ...(input.workingDirectory ? { requestWorkingDirectory: input.workingDirectory } : {}),
  });
  const executor = createRegisteredToolNormalInvocationExecutor({
    registrations: [registered],
    toolRegistry: boundRegistry,
    requestId: input.requestId,
    abortSignal: input.abortSignal,
    toolPermissionMode: input.capturedGrant.mode,
    nextApprovalId: randomUUID,
    sharedState: boundRegistry.prepareSharedState?.(),
  });
  const selected = executor.operations.find((candidate) =>
    sameOperation(requested, {
      toolName: registered.toolName,
      operationId: candidate.operation.operationId,
      contractVersion: registered.contract.version,
    }));
  if (!selected) return { kind: "rejected", code: "automation_operation_unavailable", message: "The selected operation could not be bound." };
  const prepared = await executor.prepare({
    handle: selected.handle,
    controls: input.controls,
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
  });
  if (prepared.status === "rejected")
    return { kind: "rejected", code: prepared.code, message: prepared.message };
  if (prepared.approvalRequest)
    return { kind: "rejected", code: "automation_approval_required", message: "This operation needs an interactive approval." };

  const attempt = { invocationId: randomUUID(), fingerprint: prepared.actionFingerprint };
  const releaseAdmission = input.holdEffectAdmission?.();
  try {
    await input.beforeEffect(attempt);
    const latestGrant = await input.currentGrant();
    if (input.abortSignal.aborted) {
      const rejected: AutomationToolStepOutcome = {
        kind: "rejected", code: "request_aborted",
        message: "The operation was stopped before it began.",
      };
      await input.afterEffect(attempt, rejected, true);
      return rejected;
    }
    if (!permittedByLatestGrant(
      latestGrant, input.capturedGrant, input.environmentId,
      input.automationId, requested, requiredMode,
    )) {
      const rejected: AutomationToolStepOutcome = {
        kind: "rejected", code: "automation_operation_unavailable",
        message: "The operation was stopped before it began.",
      };
      await input.afterEffect(attempt, rejected, true);
      return rejected;
    }

    let outcome: AutomationToolStepOutcome;
    try {
      activeInvocationId = attempt.invocationId;
      const settled = await prepared.execute(attempt.invocationId);
      outcome = projectAutomationToolStepOutcome(settled, selected.operation.effect, noModel.wasRequested());
    } catch (error) {
      outcome = classifyAutomationToolDispatchFailure(
        error, input.abortSignal, selected.operation.effect, dispatched,
      );
    }
    const wasRejectedBeforeDispatch = !dispatched && outcome.kind === "rejected";
    await input.afterEffect(attempt, outcome, wasRejectedBeforeDispatch);
    return outcome;
  } finally {
    releaseAdmission?.();
  }
}
