import { parseModelReasoningBudget, parseModelReasoningPreference } from "../shared/model-reasoning.js";
import type { AgentMode, ModelReasoningLevel } from "../shared/types.js";
import type { EffectiveModelReasoning, InvocationReasoningPresentation, RequestModelSelectionPresentation } from "../shared/session-model-selection.js";
import type { SessionRecord, SessionRequestRecord, SessionRequestStatus, SessionRuntimeEvent } from "./types.js";
import { isCommandSessionRequest } from "./request-kind.js";

export type SessionModelSelection = RequestModelSelectionPresentation & Readonly<{
  requestId: string;
  generation?: string;
  status: SessionRequestStatus;
  effectiveReasoning?: EffectiveModelReasoning;
  /** Original runtime event sequence; never substitute the storage replay cursor. */
  reasoningEventSequence?: number;
}>;

function eventBelongsToRequest(event: SessionRuntimeEvent, request: SessionRequestRecord): boolean {
  if (event.requestId !== request.requestId) return false;
  if (event.payload.requestId !== undefined && event.payload.requestId !== request.requestId) return false;
  if (event.payload.generation === undefined) return true;
  return event.payload.generation === request.generation;
}

function isActiveRequest(request: SessionRequestRecord): boolean {
  return request.status === "streaming" || request.status === "awaiting_approval";
}

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isNewerOrActiveConversationRequest(candidate: SessionRequestRecord, current: SessionRequestRecord): boolean {
  if (isActiveRequest(candidate) !== isActiveRequest(current)) return isActiveRequest(candidate);
  return timestamp(candidate.createdAt) >= timestamp(current.createdAt);
}

function latestRequest(requests: readonly SessionRequestRecord[]): SessionRequestRecord | undefined {
  let latest: SessionRequestRecord | undefined;
  for (const request of requests) {
    if (isCommandSessionRequest(request)) continue;
    if (!latest) { latest = request; continue; }
    if (isNewerOrActiveConversationRequest(request, latest)) latest = request;
  }
  return latest;
}

function readAgentMode(value: unknown): AgentMode | undefined {
  if (value === "fast" || value === "reasoning" || value === "deep") return value;
  return undefined;
}

function readReasoningPreference(value: unknown): RequestModelSelectionPresentation["reasoningPreference"] {
  try { return parseModelReasoningPreference(value); }
  catch { return undefined; }
}

function readPrimaryModel(value: unknown): RequestModelSelectionPresentation["primaryModel"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const model = value as Record<string, unknown>;
  if (typeof model.label !== "string" || typeof model.provider !== "string" || typeof model.model !== "string") return undefined;
  return { label: model.label, provider: model.provider, model: model.model };
}

function readSelection(event: SessionRuntimeEvent, request: SessionRequestRecord): RequestModelSelectionPresentation {
  const payload = event.payload;
  const primaryProfileId = typeof payload.primaryProfileId === "string" ? payload.primaryProfileId.trim() : "";
  const agentMode = readAgentMode(payload.agentMode);
  const reasoningPreference = readReasoningPreference(payload.reasoningPreference);
  const primaryModel = readPrimaryModel(payload.primaryModel);
  const rootModelSteps = Array.isArray(payload.rootModelSteps)
    ? [...new Set(payload.rootModelSteps.filter((step): step is string => typeof step === "string" && step.length > 0))] : [];
  return {
    selectedAt: timestamp(payload.selectedAt) || timestamp(event.timestamp) || timestamp(request.createdAt),
    ...(primaryProfileId ? { primaryProfileId } : {}),
    ...(agentMode ? { agentMode } : {}),
    ...(reasoningPreference ? { reasoningPreference } : {}),
    ...(primaryModel ? { primaryModel } : {}),
    ...(rootModelSteps.length ? { rootModelSteps } : {}),
  };
}

function readInvocationReasoning(payload: Record<string, unknown>): InvocationReasoningPresentation {
  const effort = payload.reasoningEffort;
  const reasoningEffort = ["none", "minimal", "low", "medium", "high", "xhigh"].includes(String(effort))
    ? effort as ModelReasoningLevel : undefined;
  const source = payload.reasoningControlSource;
  const reasoningControlSource = ["invocation", "request", "configuration", "agent-mode"].includes(String(source))
    ? source as InvocationReasoningPresentation["reasoningControlSource"] : undefined;
  let reasoningBudget;
  try { reasoningBudget = parseModelReasoningBudget(payload.reasoningBudget); }
  catch { /* Malformed legacy diagnostics do not become controls. */ }
  return {
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(reasoningBudget ? { reasoningBudget } : {}),
    ...(reasoningControlSource ? { reasoningControlSource } : {}),
  };
}

function isAcceptedRootSnapshot(event: SessionRuntimeEvent, selection: RequestModelSelectionPresentation): boolean {
  if (event.payload.name !== "context.window.snapshot") return false;
  if (event.payload.admissionOutcome !== "accepted") return false;
  if (typeof event.payload.modelStep !== "string") return false;
  return selection.rootModelSteps?.includes(event.payload.modelStep) === true;
}

function readReasoningEventSequence(value: unknown): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function latestReasoningEvidence(request: SessionRequestRecord, selection: RequestModelSelectionPresentation): Pick<SessionModelSelection, "effectiveReasoning" | "reasoningEventSequence"> {
  for (let index = request.events.length - 1; index >= 0; index -= 1) {
    const event = request.events[index]!;
    if (!eventBelongsToRequest(event, request)) continue;
    if (!isAcceptedRootSnapshot(event, selection)) continue;
    const sequence = readReasoningEventSequence(event.payload.eventSequence);
    const order = sequence === undefined ? {} : { reasoningEventSequence: sequence };
    // A calibrated root replacement must clear, not inherit, the primary model's controls.
    if (event.payload.profileId !== selection.primaryProfileId) return order;
    if (!selection.primaryProfileId) return order;
    return { ...order, effectiveReasoning: { profileId: selection.primaryProfileId,
      modelStep: String(event.payload.modelStep), ...readInvocationReasoning(event.payload) } };
  }
  return {};
}

function latestSelectionEvent(request: SessionRequestRecord): SessionRuntimeEvent | undefined {
  for (let index = request.events.length - 1; index >= 0; index -= 1) {
    const event = request.events[index]!;
    if (!eventBelongsToRequest(event, request)) continue;
    if (event.payload.name === "request.model.selected") return event;
  }
  return undefined;
}

/** Latest chat selection is independent of the visible message/history page. */
export function projectSessionModelSelection(session: Pick<SessionRecord, "requests">): SessionModelSelection | undefined {
  const request = latestRequest(session.requests ?? []);
  if (!request) return undefined;
  const identity = {
    requestId: request.requestId, status: request.status,
    ...(request.generation ? { generation: request.generation } : {}),
  };
  const event = latestSelectionEvent(request);
  if (!event) return { ...identity, selectedAt: timestamp(request.createdAt) };
  const selection = readSelection(event, request);
  return { ...identity, ...selection, ...latestReasoningEvidence(request, selection) };
}
