import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RequestContextPinnedPart } from "../../context/request-context-contracts.js";
import {
  projectMemoryRecallContinuations,
  type MemoryRecallContinuation,
} from "../../long-term-memory/recall-continuation.js";
import type { SupervisorResumeContext } from "./contracts.js";
import { buildSupervisorChildContinuationParts } from "./resume.js";

/** Place recalls using the child-return position captured when each was accepted. */
export function buildSupervisorMemoryRecallContinuationParts(params: {
  memoryRecallMessage: ChatMessage;
  resume?: SupervisorResumeContext;
  currentCallId: string;
  currentInvocationAttempt: number;
}): readonly RequestContextPinnedPart[] {
  const recalls = projectMemoryRecallContinuations(params.memoryRecallMessage);
  const children = params.resume
    ? buildSupervisorChildContinuationParts({ ...params, resume: params.resume })
    : [];
  return interleaveSupervisorMemoryRecalls(recalls, params.currentCallId, children);
}

/** A terminal caller can have no child snapshot after a capability continuation. */
export function interleaveSupervisorMemoryRecalls(
  recalls: readonly MemoryRecallContinuation[],
  currentCallId: string,
  children?: readonly RequestContextPinnedPart[],
): readonly RequestContextPinnedPart[] {
  const recallPart = (recall: MemoryRecallContinuation): RequestContextPinnedPart => Object.freeze({
    sourceRef: `memory-recall:${currentCallId}:${recall.invocationAttempt}`,
    category: "role_continuation",
    retention: "exact",
    messages: recall.messages,
  });
  if (!children) return Object.freeze(recalls.map(recallPart));
  if (!hasBoundRecallChildPositions(recalls, children.length)) {
    throw new Error("memory_recall_child_position_invalid");
  }
  const parts: RequestContextPinnedPart[] = [];
  for (let childIndex = 0; childIndex <= children.length; childIndex++) {
    for (const recall of recalls) {
      if (recall.completedChildCount !== childIndex) continue;
      parts.push(recallPart(recall));
    }
    const child = children[childIndex];
    if (child) parts.push(child);
  }
  return Object.freeze(parts);
}

function hasBoundRecallChildPositions(
  recalls: readonly MemoryRecallContinuation[],
  completedChildCount: number,
): boolean {
  return recalls.every((recall) => recall.completedChildCount <= completedChildCount);
}
