import type { ChatMessage, ModelGatewayAttachment } from "../../model-gateway/types.js";
import { buildCoreSkillReadContextMessages } from "../context/core-skill-read-context.js";
import { hasSuperContextContract } from "../context/super-context-policy.js";
import {
  readSuperWorkerCompactionSidecar,
  type SuperWorkerCompactionSidecar,
} from "../context/super-worker-compaction-sidecar.js";
import type { RequestContextPinnedPart } from "../context/request-context-contracts.js";
import type { WorkerCapabilityPayloadAuthor, WorkerCapabilityPayloadModelRequest } from "../orchestration/worker-capabilities/payload-contracts.js";
import { isSupervisorSkillWriteCapabilityId } from "../orchestration/worker-capabilities/supervisor-skill-authority.js";
import { buildCompletedSupervisorChildContinuationParts } from "../steps/supervisor-decision/resume.js";
import { findCapturedPersonalSkillEditTarget } from "./supervisor-skill-edit-target.js";
import type { RequestExecutionSeed } from "./contracts.js";
import { projectRootSessionMemory, type RootSessionMemoryProjection } from "../context/session-memory/root-projection.js";
import { createSessionMemoryAwareCompactionController } from "../context/session-memory/model-step-controller.js";
import type { ModelStepContextCompactionController } from "../model/model-step-port.js";

type PayloadAuthorInput = Parameters<WorkerCapabilityPayloadAuthor["author"]>[0];

/** The accepted edit uses the exact captured revision, never a fresh Store read. */
export function prepareSupervisorSkillPayloadInput(input: PayloadAuthorInput): PayloadAuthorInput {
  const sidecar = readSuperWorkerCompactionSidecar(input.settledCapabilityResults);
  if (!isSupervisorSkillOwner(sidecar, input.call.callId, input.descriptor.capabilityId)) return input;
  if (input.descriptor.capabilityId !== "update_skill") return input;
  const document = typeof input.controls.skillId === "string" && typeof input.controls.expectedRevision === "number"
    ? findCapturedPersonalSkillEditTarget(sidecar.head, input.controls.skillId, input.controls.expectedRevision)
    : undefined;
  if (!document) throw new Error("supervisor_skill_edit_target_revision_mismatch");
  return Object.freeze({
    ...input,
    stage: Object.freeze({ index: 1, count: 1, outputParam: "content" }),
    targetContext: Object.freeze({
      targetParam: "skillId", targetPath: document.skillId,
      presentation: "full" as const, content: document.content,
    }),
  });
}

export function projectPayloadSkillGuidance(input: WorkerCapabilityPayloadModelRequest): readonly ChatMessage[] {
  if (input.context.contextScope !== "standard") return [];
  const messages = buildCoreSkillReadContextMessages(input.superWorkerCompaction?.head, "delegate");
  if (!isSupervisorSkillPayload(input) || input.context.acceptedCapability.capabilityId !== "update_skill")
    return messages;
  const targetId = input.context.targetContext?.targetPath;
  return messages.filter(({ content }) => JSON.parse(content).document?.skillId !== targetId);
}

/** Keep child evidence compactable while the full replacement target stays exact. */
export function projectSupervisorSkillPayloadContinuation(
  input: WorkerCapabilityPayloadModelRequest,
  targetContentMessage: ChatMessage | undefined,
): Readonly<{ continuationParts?: readonly RequestContextPinnedPart[]; continuationMessages?: readonly ChatMessage[] }> {
  if (!isSupervisorSkillPayload(input)) return targetContentMessage
    ? { continuationMessages: [targetContentMessage] } : {};
  const parts: RequestContextPinnedPart[] = [
    ...buildCompletedSupervisorChildContinuationParts(input.superWorkerCompaction?.head),
  ];
  if (targetContentMessage) parts.push(Object.freeze({
    sourceRef: `supervisor-skill-edit-target:${input.executionId}`,
    category: "role_continuation", retention: "exact",
    messages: Object.freeze([targetContentMessage]),
  }));
  return parts.length ? { continuationParts: Object.freeze(parts) } : {};
}

export function projectSupervisorSkillPayloadRequestSource(
  input: WorkerCapabilityPayloadModelRequest,
  message: ChatMessage,
  attachments: ModelGatewayAttachment[] | undefined,
): ChatMessage {
  if (!isSupervisorSkillPayload(input) || !attachments?.length) return message;
  return { role: "user", content: message.content, attachments };
}

/** Conversation remains in its existing history lane, before budgeting. */
export function projectSupervisorSkillPayloadHistory(
  input: WorkerCapabilityPayloadModelRequest,
  request: Pick<RequestExecutionSeed, "historyMessages" | "sessionMemory">,
): RootSessionMemoryProjection | undefined {
  if (!usesSupervisorSkillRequestHistory(input)) return undefined;
  return projectRootSessionMemory(request);
}

export function createSupervisorSkillPayloadCompactionController(
  input: WorkerCapabilityPayloadModelRequest,
  request: Parameters<typeof createSessionMemoryAwareCompactionController>[0],
  activeRequestController: ModelStepContextCompactionController,
): ModelStepContextCompactionController {
  if (!usesSupervisorSkillRequestHistory(input)) return activeRequestController;
  return createSessionMemoryAwareCompactionController(request, activeRequestController);
}

function usesSupervisorSkillRequestHistory(input: WorkerCapabilityPayloadModelRequest): boolean {
  if (input.requestSourceProjection !== "full_request") return false;
  return isSupervisorSkillPayload(input);
}

function isSupervisorSkillPayload(input: WorkerCapabilityPayloadModelRequest): boolean {
  if (!("root" in input.context) || input.context.contextScope !== "standard") return false;
  return isSupervisorSkillOwner(input.superWorkerCompaction, input.context.root.callId,
    input.context.acceptedCapability.capabilityId);
}

function isSupervisorSkillOwner(
  sidecar: SuperWorkerCompactionSidecar | undefined,
  callId: string,
  capabilityId: string,
): sidecar is SuperWorkerCompactionSidecar {
  if (!sidecar || !isSupervisorSkillWriteCapabilityId(capabilityId)) return false;
  const { head } = sidecar;
  if (!hasSuperContextContract(head.policy.authority, "supervisor")) return false;
  if (sidecar.callId !== callId || sidecar.parentCallId !== null || head.state.rootCallId !== callId) return false;
  const call = head.state.calls.find((candidate) => candidate.callId === callId);
  return call?.roleId === "supervisor" && call.parentCallId === null && call.depth === 0;
}
