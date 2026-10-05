import type {
  RegisteredToolNormalInvocation, ToolExecutionSharedState, ToolNormalInvocationAttachmentInput,
  ToolUnderlyingSettlement,
} from "../../capabilities/tool-types.js";
import type { ToolRegistry } from "../ports.js";
import type { OperationRef } from "./definition-contracts.js";
import { sameOperation } from "./permission-grants.js";

function selectedRegistrations(
  registry: ToolRegistry,
  selections: readonly OperationRef[],
): RegisteredToolNormalInvocation[] {
  return (registry.listNormalInvocations?.() ?? []).flatMap((registration) => {
    const operations = registration.contract.operations.filter((operation) =>
      selections.some((selected) => sameOperation(selected, {
        toolName: registration.toolName,
        operationId: operation.operationId,
        contractVersion: registration.contract.version,
      })));
    return operations.length > 0
      ? [{ ...registration, contract: { ...registration.contract, operations } }]
      : [];
  });
}

function admittedAttachmentInput(
  registrations: readonly RegisteredToolNormalInvocation[],
  toolName: string,
  admitted: OperationRef | undefined,
): ToolNormalInvocationAttachmentInput | undefined {
  if (!admitted) return undefined;
  const registration = registrations.find((item) => item.toolName === toolName);
  return registration?.contract.operations.find((operation) => sameOperation(admitted, {
    toolName: registration.toolName,
    operationId: operation.operationId,
    contractVersion: registration.contract.version,
  }))?.attachmentInput;
}

/** Node-level admission can accept several MIME types; each operation receives only its own. */
function scopeOperationAttachments(
  sharedState: ToolExecutionSharedState | undefined,
  attachmentInput: ToolNormalInvocationAttachmentInput | undefined,
): ToolExecutionSharedState | undefined {
  if (!sharedState) return undefined;
  const scoped = { ...sharedState };
  if (!attachmentInput) {
    delete scoped.requestAttachments;
    return scoped;
  }
  if (!scoped.requestAttachments) return scoped;
  scoped.requestAttachments = scoped.requestAttachments.filter((attachment) =>
    attachmentInput.acceptedMimeTypes.includes(attachment.mimeType));
  return scoped;
}

export function scopeToolRegistry(
  registry: ToolRegistry,
  selected: readonly OperationRef[],
  admissions: WeakMap<object, string>,
  admittedOperations: ReadonlyMap<string, OperationRef>,
  observeUnderlying: (invocationId: string, settled: Promise<ToolUnderlyingSettlement>) => void,
  invokeTool: <T>(invoke: () => Promise<T>) => Promise<T>,
): ToolRegistry {
  const registrations = selectedRegistrations(registry, selected);
  const names = new Set(registrations.map((item) => item.toolName));
  const definitions = registry.listDefinitions().filter((item) => names.has(item.name));
  const implementations = Object.fromEntries(Object.entries(registry.getImplementations())
    .filter(([name]) => names.has(name)));
  return {
    listDefinitions: () => definitions,
    listNormalInvocations: () => registrations,
    getDefinition: (name) => names.has(name) ? registry.getDefinition(name) : undefined,
    ...(registry.getAdapter
      ? { getAdapter: (name: string) => names.has(name) ? registry.getAdapter!(name) : undefined }
      : {}),
    hasToolsAvailable: () => registrations.length > 0,
    getImplementations: () => implementations,
    ...(registry.prepareSharedState
      ? { prepareSharedState: registry.prepareSharedState.bind(registry) }
      : {}),
    execute: (call, options) => {
      const admission = options?.trustedEffectAdmission;
      const invocationId = admission && admissions.get(admission);
      const hasScopedAdmission = names.has(call.tool) && admission && invocationId;
      if (!hasScopedAdmission) return Promise.resolve({
        ok: false, tool: call.tool, output: "Operation unavailable to this automation.",
        producedNewInformation: false, errorCode: "automation_operation_unavailable",
      });
      admissions.delete(admission);
      const attachmentInput = admittedAttachmentInput(registrations, call.tool,
        admittedOperations.get(invocationId));
      const sharedState = scopeOperationAttachments(options?.sharedState, attachmentInput);
      return invokeTool(() => registry.execute(call, { ...options, ...(sharedState ? { sharedState } : {}),
        onUnderlyingSettlement: (settled) => observeUnderlying(invocationId, settled),
      }));
    },
  };
}
