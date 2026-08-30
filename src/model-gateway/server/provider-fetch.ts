import type { IncomingMessage, ServerResponse } from "node:http";

import { traceDebug } from "../../runtime/observability/debug-logger.js";
import { createContextWindowGuardedProviderFetch } from "../model-io-trace.js";
import type {
  ModelGatewayEmbeddingRequest,
  ModelGatewayRequest,
} from "../types.js";
import type { ProviderFetchParams } from "./contracts.js";

type DiagnosticRequestBody = ModelGatewayRequest | ModelGatewayEmbeddingRequest;

function readDebugRequestId(requestBody: DiagnosticRequestBody): string {
  return typeof requestBody.debugRequestId === "string"
    ? requestBody.debugRequestId
    : "";
}

function readModelStep(requestBody: DiagnosticRequestBody): string {
  return "modelStep" in requestBody && typeof requestBody.modelStep === "string"
    ? requestBody.modelStep
    : "";
}

function serializeAbortReason(reason: unknown): {
  name: string;
  message: string;
} {
  return reason instanceof Error
    ? { name: reason.name, message: reason.message }
    : { name: "Error", message: String(reason) };
}

function combineProviderAbortSignals(
  downstreamSignal: AbortSignal,
  adapterSignal?: AbortSignal | null,
): AbortSignal {
  const hasDistinctAdapterSignal =
    adapterSignal !== undefined &&
    adapterSignal !== null &&
    adapterSignal !== downstreamSignal;
  return hasDistinctAdapterSignal
    ? AbortSignal.any([downstreamSignal, adapterSignal])
    : downstreamSignal;
}

export function createAbortBoundProviderFetch(
  params: ProviderFetchParams,
): typeof fetch {
  const startedAt = Date.now();
  let abortLogged = false;

  const traceAbort = (signal: AbortSignal) => {
    if (abortLogged) {
      return;
    }
    abortLogged = true;
    traceDebug("model-gateway.server", "provider.abort.propagated", {
      requestId: readDebugRequestId(params.requestBody),
      endpoint: params.endpoint,
      modelStep: readModelStep(params.requestBody),
      profileId: params.invocation.profile.id,
      providerId: params.invocation.profile.providerId,
      provider: params.invocation.profile.provider,
      model: params.invocation.model,
      phase: "provider_fetch",
      source: params.abortSignal.aborted
        ? "downstream_client"
        : "adapter_signal",
      elapsedMs: Date.now() - startedAt,
      reason: serializeAbortReason(signal.reason),
    });
  };

  return async (input, init) => {
    const signal = combineProviderAbortSignals(
      params.abortSignal,
      init?.signal,
    );
    if (signal.aborted) {
      traceAbort(signal);
    } else {
      signal.addEventListener("abort", () => traceAbort(signal), {
        once: true,
      });
    }
    return params.fetchImpl(input, { ...init, signal });
  };
}

export function createContextGuardedProviderFetch(
  params: ProviderFetchParams & Readonly<{ endpoint: "chat" | "raw" }>,
): typeof fetch {
  return createContextWindowGuardedProviderFetch({
    endpoint: params.endpoint,
    requestBody: params.requestBody,
    invocation: params.invocation,
    fetchImpl: createAbortBoundProviderFetch(params),
    ...(params.inputTokenMeasurement
      ? { inputTokenMeasurement: params.inputTokenMeasurement }
      : {}),
  });
}

export function createProviderRequestAbortScope(params: {
  req: IncomingMessage;
  res: ServerResponse;
  endpoint: "chat" | "raw" | "input_tokens" | "embeddings";
  requestBody: DiagnosticRequestBody;
}): Readonly<{
  signal: AbortSignal;
  dispose(): void;
}> {
  const controller = new AbortController();
  const startedAt = Date.now();
  const requestId = readDebugRequestId(params.requestBody);
  const modelStep = readModelStep(params.requestBody);

  const abort = (source: "request_aborted" | "response_closed") => {
    const responseAlreadyCompleted = params.res.writableEnded;
    if (controller.signal.aborted || responseAlreadyCompleted) {
      return;
    }
    const reason = new Error(`model_gateway_client_disconnected:${source}`);
    reason.name = "AbortError";
    traceDebug("model-gateway.server", "provider.abort.requested", {
      requestId,
      endpoint: params.endpoint,
      modelStep,
      source,
      elapsedMs: Date.now() - startedAt,
    });
    controller.abort(reason);
  };

  const onRequestAborted = () => abort("request_aborted");
  const onResponseClosed = () => abort("response_closed");
  params.req.once("aborted", onRequestAborted);
  params.res.once("close", onResponseClosed);

  const requestAlreadyClosed = params.req.aborted || params.res.destroyed;
  if (requestAlreadyClosed) {
    abort(params.req.aborted ? "request_aborted" : "response_closed");
  }

  return {
    signal: controller.signal,
    dispose() {
      params.req.off("aborted", onRequestAborted);
      params.res.off("close", onResponseClosed);
    },
  };
}
