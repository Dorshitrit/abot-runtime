import type { ChatMessage } from "../../model-gateway/types.js";
import type { ModelStep } from "../../shared/model-steps.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../orchestration/role-calls/index.js";
import type { OperationSupervisionEvidenceEntry } from "./operation-supervision-evidence.js";

const CURRENT_SUPERVISION_AUTHORITY = Symbol(
  "currentOperationSupervisionAuthority",
);
export type OperationSupervisionEvidenceContext = Readonly<{
  requestId: string;
  call: Readonly<{ roleId: string; callId: string; activationCount?: number }>;
  sourceRevision: number;
  consumer?: ModelStep;
}>;
type EvidenceBinding = Readonly<{
  requestId: string;
  roleId: string;
  callId: string;
  activationCount: number;
  sourceRevision: number;
  // Serialized snapshots cannot be mutated through nested canonical objects.
  exactEntriesJson: string;
}>;
type MessageAuthority = Readonly<{
  message: ChatMessage;
  binding: EvidenceBinding;
}>;

/** Only canonical builders mint current evidence; JSON is never authority. */
export function bindOperationSupervisionEvidenceMessage(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
  content: string,
  exactEntries: readonly OperationSupervisionEvidenceEntry[],
): ChatMessage {
  if (!head.state.calls.some((candidate) => candidate === call)) {
    throw new Error("operation_supervision_evidence_call_invalid");
  }
  return bindMessage(
    content,
    Object.freeze({
      requestId: head.state.requestId,
      roleId: call.roleId,
      callId: call.callId,
      activationCount: call.activationCount,
      sourceRevision: head.revision,
      exactEntriesJson: JSON.stringify(exactEntries),
    }),
  );
}

export function readOperationSupervisionEvidenceBinding(
  message: ChatMessage,
): EvidenceBinding | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(
    message,
    CURRENT_SUPERVISION_AUTHORITY,
  );
  if (!descriptor) return undefined;
  const authority = descriptor.value as MessageAuthority | undefined;
  if (
    !authority ||
    !Object.isFrozen(authority) ||
    authority.message !== message ||
    descriptor.enumerable !== false ||
    descriptor.configurable !== false ||
    descriptor.writable !== false
  ) {
    throw new Error("operation_supervision_evidence_message_binding_invalid");
  }
  return authority.binding;
}

export function assertOperationSupervisionEvidenceContext(
  binding: EvidenceBinding,
  context: OperationSupervisionEvidenceContext,
): void {
  const matchesIdentity =
    binding.requestId === context.requestId &&
    binding.callId === context.call.callId &&
    binding.roleId === context.call.roleId &&
    binding.activationCount === context.call.activationCount &&
    binding.sourceRevision === context.sourceRevision;
  const permittedConsumer =
    context.consumer === "execution.decision" ||
    context.consumer === "execution.response" ||
    context.consumer === "worker.decision" ||
    context.consumer === "worker.result";
  const matchesRole =
    binding.roleId === "worker"
      ? context.consumer === "worker.decision" ||
        context.consumer === "worker.result"
      : context.consumer === "execution.decision" ||
        context.consumer === "execution.response";
  if (!matchesIdentity || !permittedConsumer || !matchesRole) {
    throw new Error("operation_supervision_evidence_context_binding_invalid");
  }
}

/** A projection carries the same authority only through this internal owner. */
export function rebindOperationSupervisionEvidenceMessage(
  message: ChatMessage,
  content: string,
): ChatMessage {
  const binding = readOperationSupervisionEvidenceBinding(message);
  if (!binding)
    throw new Error("operation_supervision_evidence_message_binding_invalid");
  return content === message.content ? message : bindMessage(content, binding);
}

function bindMessage(content: string, binding: EvidenceBinding): ChatMessage {
  const message = { role: "user" as const, content };
  Object.defineProperty(message, CURRENT_SUPERVISION_AUTHORITY, {
    value: Object.freeze({ message, binding }),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return Object.freeze(message);
}
