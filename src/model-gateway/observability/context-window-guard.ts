import { traceDebug } from "../../runtime/observability/debug-logger.js";
import type { ModelProviderInputTokenMeasurement } from "../providers/contracts.js";
import { resolveProviderEnvelopeInputTokens } from "../providers/envelope-budget.js";
import type { ModelGatewayRequest, ResolvedModelInvocation } from "../types.js";
import {
  createProviderTraceContext,
  type ProviderTraceContext,
} from "./provider-trace-context.js";

export class ModelProviderContextWindowExceededError extends Error {
  readonly statusCode = 400;
  readonly code = "model_context_window_exceeded";

  constructor() {
    super("model_context_window_exceeded");
    this.name = "ModelProviderContextWindowExceededError";
  }
}

export class ModelProviderEnvelopeInspectionError extends Error {
  readonly statusCode = 400;
  readonly code = "model_provider_envelope_uninspectable";

  constructor() {
    super("model_provider_envelope_uninspectable");
    this.name = "ModelProviderEnvelopeInspectionError";
  }
}

function parseProviderFetchPayload(
  body: BodyInit | null | undefined,
): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new ModelProviderEnvelopeInspectionError();
  }

  try {
    const decoded = JSON.parse(body) as unknown;
    const isObjectPayload =
      decoded !== null &&
      typeof decoded === "object" &&
      !Array.isArray(decoded);
    if (isObjectPayload) {
      return decoded as Record<string, unknown>;
    }
  } catch {
    // A provider dispatch without inspectable JSON cannot prove admission.
  }
  throw new ModelProviderEnvelopeInspectionError();
}

export function assertFinalProviderEnvelopeFits(params: {
  context: ProviderTraceContext;
  invocation: ResolvedModelInvocation;
  payload: Record<string, unknown>;
  inputTokenMeasurement?: ModelProviderInputTokenMeasurement;
}): void {
  const assessment = resolveProviderEnvelopeInputTokens({
    payload: params.payload,
    tokenEstimation: params.invocation.profile.context.tokenEstimation,
    ...(params.inputTokenMeasurement
      ? { measurement: params.inputTokenMeasurement }
      : {}),
  });
  const contextWindowTokens = params.invocation.profile.contextWindowTokens;
  const fitsContextWindow = assessment.inputTokens < contextWindowTokens;
  traceDebug("model-gateway.server", "provider.envelope.assessed", {
    ...params.context,
    phase: "final_provider_envelope",
    outcome: fitsContextWindow ? "accepted" : "rejected",
    inputTokens: assessment.inputTokens,
    measurement: assessment.measurement,
    source: assessment.source,
    measurementBinding: assessment.measurementBinding,
    ...(assessment.measurement === "actual"
      ? { measuredInputTokens: assessment.inputTokens }
      : { estimatedInputTokens: assessment.inputTokens }),
    contextWindowTokens,
    remainingContextTokens: Math.max(
      0,
      contextWindowTokens - assessment.inputTokens,
    ),
  });
  if (!fitsContextWindow) {
    throw new ModelProviderContextWindowExceededError();
  }
}

/** Guards the fetch capability supplied to every provider adapter. */
export function createContextWindowGuardedProviderFetch(params: {
  endpoint: "chat" | "raw";
  requestBody: ModelGatewayRequest;
  invocation: ResolvedModelInvocation;
  fetchImpl: typeof fetch;
  inputTokenMeasurement?: ModelProviderInputTokenMeasurement;
}): typeof fetch {
  const context = createProviderTraceContext(params);
  return async (input, init) => {
    const payload = parseProviderFetchPayload(init?.body);
    assertFinalProviderEnvelopeFits({
      context,
      invocation: params.invocation,
      payload,
      ...(params.inputTokenMeasurement
        ? { inputTokenMeasurement: params.inputTokenMeasurement }
        : {}),
    });
    return params.fetchImpl(input, init);
  };
}
