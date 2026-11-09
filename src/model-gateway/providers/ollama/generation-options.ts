import type { ResolvedModelInvocation } from "../../types.js";
import { estimateProviderEnvelopeInputTokens } from "../envelope-budget.js";

const DEFAULT_OLLAMA_KEEP_ALIVE = "3m";

export function readOptionalPositiveIntEnv(name: string): number | undefined {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined;
}

function resolveNumPredict(params: {
  baseOptions: Record<string, unknown>;
  derivedNumPredict: number;
}): number | undefined {
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
}): number {
  const estimatedInputTokens = estimateProviderEnvelopeInputTokens(
    params.payload,
    params.invocation.profile.context.tokenEstimation,
  );
  // Ollama counts thinking and answer tokens against the same generation budget.
  return Math.max(
    1,
    params.invocation.profile.contextWindowTokens - estimatedInputTokens,
  );
}

export function resolveOllamaKeepAlive(
  invocation: ResolvedModelInvocation,
): string {
  const configured = invocation.profile.providerConfig?.keepAlive?.trim();
  return configured || DEFAULT_OLLAMA_KEEP_ALIVE;
}
