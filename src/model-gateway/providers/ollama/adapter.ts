import { fetchProviderWithTrace } from "../../model-io-trace.js";
import type { OllamaSchemaProjectionDiagnostic } from "../../structured-output/projection.js";
import type { ModelGatewayEvent } from "../../types.js";
import type {
  ModelProviderAdapter,
  ModelProviderInvocationParams,
} from "../contracts.js";
import {
  buildOllamaPayload,
  buildOllamaRawPayload,
  type OllamaPayloadBuildOptions,
} from "./payload.js";
import {
  emitOllamaRequestProjection,
  emitOllamaSchemaDiagnostics,
  emitOllamaTiming,
  resolveOllamaBaseUrl,
} from "./request-diagnostics.js";
import {
  createOllamaStreamDiagnostics,
  isAbortFailure,
  type StreamTerminationOutcome,
} from "./stream-diagnostics.js";
import {
  collectOllamaStream,
  forwardOllamaStream,
  type OllamaProviderTiming,
} from "./stream-normalizer.js";

function readRequestId(params: ModelProviderInvocationParams): string {
  return typeof params.requestBody.debugRequestId === "string"
    ? params.requestBody.debugRequestId
    : "";
}

function buildProviderPayload(
  params: ModelProviderInvocationParams,
  options: OllamaPayloadBuildOptions,
): Record<string, unknown> {
  if (params.endpoint === "chat") {
    return buildOllamaPayload(params.requestBody, options);
  }
  return buildOllamaRawPayload(params.requestBody, options);
}

function resolveFailureOutcome(error: unknown): StreamTerminationOutcome {
  return isAbortFailure(error) ? "aborted" : "failed";
}

export function createOllamaProviderAdapter(options: {
  fallbackUrl: string;
}): ModelProviderAdapter {
  return Object.freeze({
    type: "ollama",
    supportsImageInput: true,
    async invoke(params) {
      const requestId = readRequestId(params);
      let removedConstraintCount = 0;
      const payloadOptions: OllamaPayloadBuildOptions = {
        onFormatProjection(
          diagnostics: readonly OllamaSchemaProjectionDiagnostic[],
        ) {
          removedConstraintCount = diagnostics.length;
          emitOllamaSchemaDiagnostics(requestId, diagnostics);
        },
      };
      const payload = buildProviderPayload(params, payloadOptions);
      emitOllamaRequestProjection({
        invocationParams: params,
        payload,
        removedConstraintCount,
      });

      const { response, responseTrace } = await fetchProviderWithTrace({
        endpoint: params.endpoint,
        requestBody: params.requestBody,
        invocation: params.invocation,
        fetchImpl: params.fetchImpl,
        url: `${resolveOllamaBaseUrl(
          params.invocation,
          options.fallbackUrl,
        )}/api/chat`,
        headers: { "Content-Type": "application/json" },
        payload,
        decodeResponse: (body) => collectOllamaStream(body),
      });
      if (!response.ok || !response.body) {
        const message = await response.text();
        await responseTrace;
        return {
          kind: "error" as const,
          statusCode: response.status || 502,
          message: message || "ollama error",
        };
      }

      const streamDiagnostics = createOllamaStreamDiagnostics({
        invocationParams: params,
        payload,
      });
      const streamOptions = {
        onTerminalTiming: (timing: OllamaProviderTiming) =>
          emitOllamaTiming({ invocationParams: params, payload, timing }),
        onNormalizedEvent: (event: ModelGatewayEvent) =>
          streamDiagnostics.observe(event),
      };

      if (params.endpoint === "chat") {
        const body = response.body;
        return {
          kind: "chat" as const,
          async stream(writer) {
            let outcome: StreamTerminationOutcome = "completed";
            let failure: unknown;
            try {
              await forwardOllamaStream(body, writer, streamOptions);
            } catch (error) {
              outcome = resolveFailureOutcome(error);
              failure = error;
              throw error;
            } finally {
              streamDiagnostics.terminate(outcome, failure);
              await responseTrace;
            }
          },
        };
      }

      let outcome: StreamTerminationOutcome = "completed";
      let failure: unknown;
      try {
        const collected = await collectOllamaStream(
          response.body,
          streamOptions,
        );
        return {
          kind: "raw" as const,
          body: {
            text: collected.text,
            thinking: collected.thinking,
            ...(collected.usage ? { usage: collected.usage } : {}),
            ...(collected.doneReason !== undefined
              ? { providerCompletionReason: collected.doneReason }
              : {}),
          },
        };
      } catch (error) {
        outcome = resolveFailureOutcome(error);
        failure = error;
        throw error;
      } finally {
        streamDiagnostics.terminate(outcome, failure);
        await responseTrace;
      }
    },
  });
}
