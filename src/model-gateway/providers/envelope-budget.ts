import { createHash } from "node:crypto";

import { estimateTextTokens } from "../../runtime/context/token-estimator.js";
import type { ModelProviderInputTokenMeasurement } from "./contracts.js";
import type { ModelTokenEstimationConfig } from "../types.js";

export type ProviderEnvelopeInputAssessment = Readonly<{
  inputTokens: number;
  measurement: "actual" | "estimated";
  source: "provider_input_token_count" | "runtime_token_estimator";
  measurementBinding: "matched" | "missing" | "mismatched";
}>;

export function estimateProviderEnvelopeInputTokens(
  payload: Readonly<Record<string, unknown>>,
  tokenEstimation?: ModelTokenEstimationConfig,
): number {
  return estimateTextTokens(serializeTokenBearingEnvelope(payload), tokenEstimation);
}

export function createProviderEnvelopeFingerprint(
  payload: Readonly<Record<string, unknown>>,
): string {
  return `sha256:${createHash("sha256")
    .update(serializeTokenBearingEnvelope(payload))
    .digest("hex")}`;
}

export function resolveProviderEnvelopeInputTokens(params: {
  payload: Readonly<Record<string, unknown>>;
  tokenEstimation?: ModelTokenEstimationConfig;
  measurement?: ModelProviderInputTokenMeasurement;
}): ProviderEnvelopeInputAssessment {
  if (!params.measurement) {
    return estimatedEnvelopeAssessment(params);
  }

  const fingerprint = createProviderEnvelopeFingerprint(params.payload);
  if (params.measurement.providerEnvelopeFingerprint !== fingerprint) {
    return {
      ...estimatedEnvelopeAssessment(params),
      measurementBinding: "mismatched",
    };
  }

  return Object.freeze({
    inputTokens: params.measurement.inputTokens,
    measurement: "actual" as const,
    source: "provider_input_token_count" as const,
    measurementBinding: "matched" as const,
  });
}

function estimatedEnvelopeAssessment(params: {
  payload: Readonly<Record<string, unknown>>;
  tokenEstimation?: ModelTokenEstimationConfig;
}): ProviderEnvelopeInputAssessment {
  return Object.freeze({
    inputTokens: estimateProviderEnvelopeInputTokens(
      params.payload,
      params.tokenEstimation,
    ),
    measurement: "estimated" as const,
    source: "runtime_token_estimator" as const,
    measurementBinding: "missing" as const,
  });
}

function serializeTokenBearingEnvelope(
  payload: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify(projectTokenBearingProviderEnvelope(payload));
}

function projectTokenBearingProviderEnvelope(
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of [
    "messages",
    "input",
    "prompt",
    "instructions",
    "text",
    "format",
    "tools",
  ]) {
    if (Object.hasOwn(payload, key)) {
      selected[key] = stripProviderBinaryData(payload[key], key);
    }
  }
  return selected;
}

function stripProviderBinaryData(value: unknown, key = ""): unknown {
  if (
    key === "images" ||
    key === "image_url" ||
    key === "input_image" ||
    key === "data"
  ) {
    return "[binary omitted from text estimate]";
  }
  if (typeof value === "string") {
    return value.startsWith("data:")
      ? "[binary omitted from text estimate]"
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stripProviderBinaryData(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(
        ([entryKey, entryValue]) => [
          entryKey,
          stripProviderBinaryData(entryValue, entryKey),
        ],
      ),
    );
  }
  return value;
}
