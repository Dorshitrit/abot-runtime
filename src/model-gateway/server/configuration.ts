import { createHash } from "node:crypto";
import { join } from "node:path";

import { loadRuntimeConfig } from "../../runtime/config.js";
import { RUNTIME_LOGS_DIR_NAME } from "../../runtime/config/layout.js";
import { loadRequestRunnerConfig } from "../../runtime/config/runner/loader.js";
import { createRequestModelPolicy } from "../../runtime/config/runner/model-policy.js";
import { configureDebugLogger } from "../../runtime/observability/debug-logger.js";
import {
  DEFAULT_MODEL_GATEWAY_URL,
  DEFAULT_OLLAMA_URL,
} from "../../shared/constants.js";
import { configureModelIoTrace } from "../model-io-trace.js";
import type { ModelGatewayPolicyConfig } from "../types.js";
import type { ModelGatewayHandlerOptions } from "./contracts.js";

const MODEL_GATEWAY_TRACE_FILE_SEGMENTS = ["model-gateway.jsonl"] as const;
const MODEL_IO_TRACE_FILE_SEGMENTS = ["model-io.jsonl"] as const;

function resolveConfiguredTraceFile(
  environmentName: string,
): string | undefined {
  const configured = process.env[environmentName]?.trim();
  return configured && configured.length > 0 ? configured : undefined;
}

function resolveTraceFile(params: {
  configuredPath?: string;
  sharedDir: string;
  segments: readonly string[];
}): string {
  return (
    params.configuredPath ??
    join(params.sharedDir, RUNTIME_LOGS_DIR_NAME, ...params.segments)
  );
}

export function resolveModelGatewayPort(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const configuredPort = Number(environment.PORT);
  const hasExplicitPort = Number.isFinite(configuredPort) && configuredPort > 0;
  if (hasExplicitPort) {
    return Math.trunc(configuredPort);
  }

  const configuredUrl =
    environment.MODEL_GATEWAY_URL || DEFAULT_MODEL_GATEWAY_URL;
  const parsedUrl = new URL(configuredUrl);
  return Number(parsedUrl.port || "80");
}

function resolveModelGatewayConfiguration(options: ModelGatewayHandlerOptions) {
  const runtimeConfig = loadRuntimeConfig({
    rootDir: options.rootDir ?? process.cwd(),
    configPath: options.configPath,
  });
  const modelPolicy =
    options.modelPolicy ??
    createRequestModelPolicy({
      platformPolicy: runtimeConfig.models,
      runnerConfig: loadRequestRunnerConfig({
        configPath: runtimeConfig.requestRunner.configPath,
      }),
    });

  return {
    modelGatewayUrl: runtimeConfig.modelGatewayUrl,
    modelPolicy,
    debugLogging: {
      traceFile: resolveTraceFile({
        configuredPath: resolveConfiguredTraceFile("MODEL_GATEWAY_TRACE_FILE"),
        sharedDir: runtimeConfig.paths.sharedDir,
        segments: MODEL_GATEWAY_TRACE_FILE_SEGMENTS,
      }),
      enabled: runtimeConfig.logging?.enabled,
      rotation: runtimeConfig.logging?.rotation,
    },
    modelIoLogging: {
      traceFile: resolveTraceFile({
        configuredPath: resolveConfiguredTraceFile(
          "MODEL_GATEWAY_MODEL_IO_TRACE_FILE",
        ),
        sharedDir: runtimeConfig.paths.sharedDir,
        segments: MODEL_IO_TRACE_FILE_SEGMENTS,
      }),
      enabled: runtimeConfig.logging?.enabled,
      rotation: runtimeConfig.logging?.rotation,
    },
  };
}

function canonicalConfiguration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalConfiguration);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalConfiguration(entry)]),
    );
  return value;
}

function providerEnvironment(
  options: ModelGatewayHandlerOptions,
  policy: ModelGatewayPolicyConfig,
) {
  const credentialNames = new Set(["OPENAI_API_KEY"]);
  for (const provider of Object.values(policy.providers ?? {})) {
    if (provider.type !== "openai") continue;
    const configuredName = provider.apiKeyEnv?.trim();
    if (configuredName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(configuredName))
      credentialNames.add(configuredName);
  }
  const numPredict = Number(process.env.OLLAMA_NUM_PREDICT);
  return {
    ollamaUrl:
      options.ollamaUrl ?? (process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL),
    openAIBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    ollamaNumPredict:
      Number.isFinite(numPredict) && numPredict > 0
        ? Math.trunc(numPredict)
        : null,
    credentials: Object.fromEntries(
      [...credentialNames].map((name) => [name, process.env[name] || null]),
    ),
  };
}

/** Captures gateway inputs without changing its loggers or retaining credentials. */
export function captureModelGatewayConfiguration(
  options: ModelGatewayHandlerOptions,
): string | null {
  if (options.providerAdapters || options.additionalProviderAdapters?.length)
    return null;
  const configuration = resolveModelGatewayConfiguration(options);
  const snapshot = {
    ...configuration,
    modelGatewayUrl: new URL(configuration.modelGatewayUrl).href,
    providerEnvironment: providerEnvironment(
      options,
      configuration.modelPolicy,
    ),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalConfiguration(snapshot)))
    .digest("hex");
}

export function configureModelGateway(
  options: ModelGatewayHandlerOptions,
): ModelGatewayPolicyConfig {
  const configuration = resolveModelGatewayConfiguration(options);
  configureDebugLogger(configuration.debugLogging);
  configureModelIoTrace(configuration.modelIoLogging);
  return configuration.modelPolicy;
}
