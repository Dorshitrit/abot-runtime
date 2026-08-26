import { traceDebug } from "../../../runtime/observability/debug-logger.js";
import type { ModelGatewayEvent } from "../../types.js";
import type { ModelProviderInvocationParams } from "../contracts.js";
import { readEffectiveOption } from "./options.js";

const STREAM_PROGRESS_START_CHARACTER_COUNT = 4_096;
const STREAM_DIAGNOSTIC_TAIL_CHARACTER_LIMIT = 8_192;
const STREAM_REPETITION_MINIMUM_UNIT_CHARACTERS = 8;
const STREAM_REPETITION_MAXIMUM_UNIT_CHARACTERS = 256;
const STREAM_REPETITION_MINIMUM_COUNT = 6;

export type StreamTerminationOutcome = "completed" | "aborted" | "failed";

type RepeatedSuffix = Readonly<{
  unitCharacterCount: number;
  repeatCount: number;
  coveredCharacterCount: number;
}>;

function serializeDiagnosticError(error: unknown): {
  name: string;
  message: string;
} {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

export function isAbortFailure(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function appendDiagnosticTail(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= STREAM_DIAGNOSTIC_TAIL_CHARACTER_LIMIT
    ? combined
    : combined.slice(-STREAM_DIAGNOSTIC_TAIL_CHARACTER_LIMIT);
}

function shouldReplaceBestRepetition(
  best: RepeatedSuffix | undefined,
  candidate: RepeatedSuffix,
): boolean {
  if (!best) {
    return true;
  }
  if (candidate.coveredCharacterCount !== best.coveredCharacterCount) {
    return candidate.coveredCharacterCount > best.coveredCharacterCount;
  }
  return candidate.unitCharacterCount < best.unitCharacterCount;
}

function detectRepeatedSuffix(value: string): RepeatedSuffix | undefined {
  const maximumUnitLength = Math.min(
    STREAM_REPETITION_MAXIMUM_UNIT_CHARACTERS,
    Math.floor(value.length / STREAM_REPETITION_MINIMUM_COUNT),
  );
  let best: RepeatedSuffix | undefined;

  for (
    let unitCharacterCount = STREAM_REPETITION_MINIMUM_UNIT_CHARACTERS;
    unitCharacterCount <= maximumUnitLength;
    unitCharacterCount += 1
  ) {
    const unit = value.slice(-unitCharacterCount);
    let repeatCount = 1;
    while (
      (repeatCount + 1) * unitCharacterCount <= value.length &&
      value.slice(
        -(repeatCount + 1) * unitCharacterCount,
        -repeatCount * unitCharacterCount,
      ) === unit
    ) {
      repeatCount += 1;
    }
    if (repeatCount < STREAM_REPETITION_MINIMUM_COUNT) {
      continue;
    }

    const candidate = {
      unitCharacterCount,
      repeatCount,
      coveredCharacterCount: repeatCount * unitCharacterCount,
    };
    if (shouldReplaceBestRepetition(best, candidate)) {
      best = candidate;
    }
  }
  return best;
}

function projectRepetition(prefix: "content" | "thinking", value: string) {
  const repetition = detectRepeatedSuffix(value);
  if (!repetition) {
    return {};
  }
  const label = prefix === "content" ? "content" : "thinking";
  return {
    [`${label}RepeatedSuffixUnitCharacterCount`]: repetition.unitCharacterCount,
    [`${label}RepeatedSuffixCount`]: repetition.repeatCount,
    [`${label}RepeatedSuffixCoveredCharacterCount`]:
      repetition.coveredCharacterCount,
  };
}

export function createOllamaStreamDiagnostics(params: {
  invocationParams: ModelProviderInvocationParams;
  payload: Record<string, unknown>;
}) {
  const { requestBody, invocation, endpoint } = params.invocationParams;
  const startedAt = Date.now();
  let eventCount = 0;
  let contentCharacterCount = 0;
  let thinkingCharacterCount = 0;
  let contentTail = "";
  let thinkingTail = "";
  let nextProgressCharacterCount = STREAM_PROGRESS_START_CHARACTER_COUNT;
  const base = {
    requestId:
      typeof requestBody.debugRequestId === "string"
        ? requestBody.debugRequestId
        : "",
    endpoint,
    modelStep:
      typeof requestBody.modelStep === "string" ? requestBody.modelStep : "",
    profileId: invocation.profile.id,
    providerId: invocation.profile.providerId,
    provider: "ollama",
    model: invocation.model,
    numCtx: readEffectiveOption(params.payload, "num_ctx"),
    numPredict: readEffectiveOption(params.payload, "num_predict"),
  };

  const snapshot = () => ({
    ...base,
    elapsedMs: Date.now() - startedAt,
    eventCount,
    contentCharacterCount,
    thinkingCharacterCount,
    totalCharacterCount: contentCharacterCount + thinkingCharacterCount,
    ...projectRepetition("content", contentTail),
    ...projectRepetition("thinking", thinkingTail),
  });

  return {
    observe(event: ModelGatewayEvent): void {
      eventCount += 1;
      if (event.type === "content") {
        contentCharacterCount += event.text.length;
        contentTail = appendDiagnosticTail(contentTail, event.text);
      } else if (event.type === "thinking") {
        thinkingCharacterCount += event.text.length;
        thinkingTail = appendDiagnosticTail(thinkingTail, event.text);
      }

      const totalCharacterCount =
        contentCharacterCount + thinkingCharacterCount;
      if (totalCharacterCount < nextProgressCharacterCount) {
        return;
      }
      while (nextProgressCharacterCount <= totalCharacterCount) {
        nextProgressCharacterCount *= 2;
      }
      traceDebug("model-gateway.server", "ollama.stream.progress", snapshot());
    },

    terminate(outcome: StreamTerminationOutcome, error?: unknown): void {
      const hasAbortReason = outcome === "aborted" && error !== undefined;
      traceDebug("model-gateway.server", "ollama.stream.terminated", {
        ...snapshot(),
        outcome,
        abortRequested: outcome === "aborted",
        ...(hasAbortReason
          ? { abortReason: serializeDiagnosticError(error) }
          : {}),
        ...(error !== undefined
          ? { error: serializeDiagnosticError(error) }
          : {}),
      });
    },
  };
}
