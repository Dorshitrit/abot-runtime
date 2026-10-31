import { fetchProviderWithTrace } from "../../model-io-trace.js";
import { toolMediaSafeError, toolMediaSafeEvent, toolMediaSafeMessage } from "../../observability/tool-media-privacy.js";
import type { ModelProviderInvocationParams, ModelProviderInvocationResult } from "../contracts.js";
import {
  emitOpenAIMessageOutputDiagnostic,
  emitOpenAIStreamTermination,
  resolveOpenAIStreamFailureOutcome,
  type OpenAIStreamTerminationOutcome,
} from "./diagnostics.js";
import {
  collectOpenAIResponsesStream,
  forwardOpenAIResponsesStream,
  type OpenAIMessageOutputNormalizationDiagnostic,
} from "./protocol.js";
import { bindOpenAIResponseLifetime } from "./response-lifetime.js";
import { resolveOpenAIFunctionOutputName } from "./function-output.js";
import { requiresSingleMessageOutput } from "./message-output-policy.js";

export async function invokeOpenAIResponses(
  params: ModelProviderInvocationParams,
  options: Readonly<{
    url: string;
    accessToken: string;
    payload: Record<string, unknown>;
    requireCompletedResponse?: boolean;
    assembleCompletedFunctionItems?: boolean;
  }>,
): Promise<ModelProviderInvocationResult> {
  const { payload } = options;
  const functionOutputName = resolveOpenAIFunctionOutputName(payload);
  const completionOptions = {
    functionOutputName,
    ...(options.requireCompletedResponse ? { requireCompletedResponse: true } : {}),
    ...(options.assembleCompletedFunctionItems ? { assembleCompletedFunctionItems: true } : {}),
  };
  const streamOptions = {
    ...completionOptions,
    structuredOutput: requiresSingleMessageOutput(params.requestBody, payload),
    onMessageOutputDiagnostic: (diagnostic: OpenAIMessageOutputNormalizationDiagnostic) =>
      emitOpenAIMessageOutputDiagnostic(params, diagnostic),
  };
  const { response, responseTrace } = await fetchProviderWithTrace({
    endpoint: params.endpoint,
    requestBody: params.requestBody,
    invocation: params.invocation,
    fetchImpl: async (input, init) => bindOpenAIResponseLifetime(
      await params.fetchImpl(input, {
        ...init,
        ...(params.abortSignal ? { signal: params.abortSignal } : {}),
      }),
      completionOptions,
    ),
    url: options.url,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.accessToken}`,
    },
    payload,
    decodeResponse: (body) => collectOpenAIResponsesStream(body, completionOptions),
  });
  if (!response.ok || !response.body) {
    const message = await response.text();
    await responseTrace;
    return {
      kind: "error",
      statusCode: response.status || 502,
      message: toolMediaSafeMessage(message || "openai error", params.requestBody),
    };
  }

  const streamStartedAt = Date.now();
  if (params.endpoint === "chat") {
    const body = response.body;
    return {
      kind: "chat",
      async stream(writer) {
        let outcome: OpenAIStreamTerminationOutcome = "completed";
        let failure: unknown;
        try {
          await forwardOpenAIResponsesStream(body, {
            emit: (event) => writer.emit(toolMediaSafeEvent(event, params.requestBody)),
          }, streamOptions);
        } catch (error) {
          outcome = resolveOpenAIStreamFailureOutcome(error);
          failure = toolMediaSafeError(error, params.requestBody);
          throw failure;
        } finally {
          emitOpenAIStreamTermination({
            invocationParams: params, startedAt: streamStartedAt, outcome,
            ...(failure !== undefined ? { error: failure } : {}),
          });
          await responseTrace;
        }
      },
    };
  }

  let outcome: OpenAIStreamTerminationOutcome = "completed";
  let failure: unknown;
  try {
    const collected = await collectOpenAIResponsesStream(response.body, streamOptions);
    return {
      kind: "raw",
      body: {
        text: collected.text,
        thinking: collected.thinking,
        ...(collected.usage ? { usage: collected.usage } : {}),
        ...(collected.doneReason ? { providerCompletionReason: collected.doneReason } : {}),
      },
    };
  } catch (error) {
    outcome = resolveOpenAIStreamFailureOutcome(error);
    failure = toolMediaSafeError(error, params.requestBody);
    throw failure;
  } finally {
    emitOpenAIStreamTermination({
      invocationParams: params, startedAt: streamStartedAt, outcome,
      ...(failure !== undefined ? { error: failure } : {}),
    });
    await responseTrace;
  }
}
