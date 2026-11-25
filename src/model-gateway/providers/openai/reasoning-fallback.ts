import { OpenAIReasoningIssue } from "./reasoning-issue.js";
import type { ModelIssueDiagnostic } from "../../protocol/model-issue.js";
import { traceDebug } from "../../../runtime/observability/debug-logger.js";
import type { ModelGatewayRequest, ResolvedModelInvocation } from "../../types.js";

type ProviderAttempt = Readonly<{
  response: Response;
  responseTrace?: Promise<void>;
}>;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

async function isUnsupportedOpenAIReasoningEffort(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  const body = await response.clone().json().catch(() => undefined);
  const error = readRecord(readRecord(body)?.error);
  if (error?.type !== "invalid_request_error") return false;
  if (error.param !== "reasoning.effort") return false;
  return error.code === "unsupported_value" || error.code === "unsupported_parameter";
}

function useProviderDefaultReasoning(payload: Record<string, unknown>): Record<string, unknown> {
  const reasoning = { ...readRecord(payload.reasoning) };
  delete reasoning.effort;
  const fallback: Record<string, unknown> = { ...payload, reasoning };
  if (Object.keys(reasoning).length === 0) {
    delete fallback.reasoning;
  }
  // Sampling controls were allowed because the requested effort was disabled.
  // The provider default may enable reasoning, so those controls cannot follow it.
  delete fallback.temperature;
  delete fallback.top_p;
  return fallback;
}

export async function fetchWithOpenAIReasoningFallback<T extends ProviderAttempt>(params: {
  payload: Record<string, unknown>;
  requestBody: ModelGatewayRequest;
  invocation: ResolvedModelInvocation;
  abortSignal?: AbortSignal;
  onIssue?: (issue: ModelIssueDiagnostic) => void;
  operation?: ModelIssueDiagnostic["operation"];
  send: (payload: Record<string, unknown>) => Promise<T>;
}): Promise<{ result: T; payload: Record<string, unknown>; issue?: OpenAIReasoningIssue }> {
  params.abortSignal?.throwIfAborted();
  const result = await params.send(params.payload);
  if (params.invocation.profile.provider !== "openai") return { result, payload: params.payload };
  const effort = readRecord(params.payload.reasoning)?.effort;
  if (typeof effort !== "string") return { result, payload: params.payload };
  if (!(await isUnsupportedOpenAIReasoningEffort(result.response))) return { result, payload: params.payload };
  const issue = new OpenAIReasoningIssue(params.invocation, effort, params.operation ?? "chat", params.onIssue);
  try {
    // Only an explicit validation rejection can reach this retry. Never replay
    // a timed-out request, an accepted stream, or an ambiguous provider failure.
    await result.responseTrace;
    await result.response.body?.cancel().catch(() => undefined);
    params.abortSignal?.throwIfAborted();
    const payload = useProviderDefaultReasoning(params.payload);
    traceDebug("model-gateway.openai", "reasoning.provider_default", {
      requestId: params.requestBody.debugRequestId,
      modelStep: params.requestBody.modelStep,
      profileId: params.invocation.profile.id,
      model: params.invocation.model,
      agentMode: params.requestBody.agentMode,
      requestedEffort: effort,
      reason: "provider_rejected_reasoning_effort",
    });
    return { result: await params.send(payload), payload, issue };
  } catch (error) {
    issue.finish(params.abortSignal?.aborted ? "interrupted" : "failed");
    throw error;
  }
}
