import { DEFAULT_MODEL_GATEWAY_URL } from "../../shared/constants.js";
import type { ModelGatewayPolicyConfig } from "../types.js";
import type { ModelGatewayClientOptions } from "./contracts.js";

const DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS = 90_000;
const DEFAULT_INPUT_TOKEN_COUNT_PROVIDERS = Object.freeze(["openai"]);

export type ResolvedModelGatewayClientOptions = {
  baseUrl: string;
  getStreamInactivityTimeoutMs: () => number;
  inputTokenCountProviders: ReadonlySet<string>;
  modelPolicy?: ModelGatewayPolicyConfig;
};

function readPositiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function getModelGatewayUrl(): string {
  return (
    process.env.MODEL_GATEWAY_URL ||
    process.env.SIMPLE_LLM_SERVER_URL ||
    DEFAULT_MODEL_GATEWAY_URL
  );
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function readConfiguredPositiveInt(
  value: number | undefined,
  fallback: () => number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback();
}

export function resolveClientOptions(
  options: ModelGatewayClientOptions = {},
): ResolvedModelGatewayClientOptions {
  return {
    baseUrl: normalizeBaseUrl(options.baseUrl ?? getModelGatewayUrl()),
    getStreamInactivityTimeoutMs: () =>
      readConfiguredPositiveInt(
        options.streamInactivityTimeoutMs,
        getModelGatewayStreamInactivityTimeoutMs,
      ),
    inputTokenCountProviders: new Set(
      (options.inputTokenCountProviders ?? DEFAULT_INPUT_TOKEN_COUNT_PROVIDERS)
        .map((provider) => provider.trim())
        .filter(Boolean),
    ),
    ...(options.modelPolicy ? { modelPolicy: options.modelPolicy } : {}),
  };
}

export function getModelGatewayStreamInactivityTimeoutMs(): number {
  return readPositiveInt(
    "LLM_RUNTIME_STREAM_INACTIVITY_TIMEOUT_MS",
    DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS,
  );
}
