import type {
  ModelGatewayFormat,
  ResolvedModelInvocation,
} from "../../types.js";
import { estimateStrictStructuredOutputTokenCeiling } from "../../structured-output/budget.js";
import { estimateProviderEnvelopeInputTokens } from "../envelope-budget.js";

const DEFAULT_OLLAMA_KEEP_ALIVE = "3m";

export function readOptionalPositiveIntEnv(name: string): number | undefined {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined;
}

function resolveNumPredict(params: {
  baseOptions: Record<string, unknown>;
  derivedNumPredict: number;
  enforceDerivedNumPredict: boolean;
}): number | undefined {
  if (params.enforceDerivedNumPredict) {
    return params.derivedNumPredict;
  }
  const environmentOverride = readOptionalPositiveIntEnv("OLLAMA_NUM_PREDICT");
  if (environmentOverride !== undefined) {
    return environmentOverride;
  }
  if (Object.hasOwn(params.baseOptions, "num_predict")) {
    return undefined;
  }
  return params.derivedNumPredict;
}

export function buildOllamaOptions(params: {
  baseOptions: Record<string, unknown>;
  generation?: {
    temperature?: number;
    topP?: number;
  };
  contextWindowTokens: number;
  derivedNumPredict: number;
  enforceDerivedNumPredict: boolean;
}): Record<string, unknown> {
  const options: Record<string, unknown> = {
    ...params.baseOptions,
    num_ctx: params.contextWindowTokens,
  };
  if (typeof params.generation?.temperature === "number") {
    options.temperature = params.generation.temperature;
  }
  if (typeof params.generation?.topP === "number") {
    options.top_p = params.generation.topP;
  }

  const numPredict = resolveNumPredict(params);
  if (numPredict !== undefined) {
    options.num_predict = numPredict;
  }
  return options;
}

export function deriveOllamaNumPredict(params: {
  payload: Readonly<Record<string, unknown>>;
  invocation: ResolvedModelInvocation;
  effectiveFormat?: ModelGatewayFormat;
  useStructuredOutputCeiling: boolean;
  outputTokenLimit?: number;
}): number {
  const estimatedInputTokens = estimateProviderEnvelopeInputTokens(
    params.payload,
    params.invocation.profile.context.tokenEstimation,
  );
  const physicalRemainingTokens = Math.max(
    1,
    params.invocation.profile.contextWindowTokens - estimatedInputTokens,
  );
  const structuredOutputCeiling = params.useStructuredOutputCeiling
    ? estimateStrictStructuredOutputTokenCeiling(
        params.effectiveFormat,
        params.invocation.profile.context.tokenEstimation,
      )
    : undefined;
  return Math.max(
    1,
    Math.min(
      physicalRemainingTokens,
      structuredOutputCeiling ?? physicalRemainingTokens,
      params.outputTokenLimit ?? physicalRemainingTokens,
    ),
  );
}

export function resolveOllamaKeepAlive(
  invocation: ResolvedModelInvocation,
): string {
  const configured = invocation.profile.providerConfig?.keepAlive?.trim();
  return configured || DEFAULT_OLLAMA_KEEP_ALIVE;
}
