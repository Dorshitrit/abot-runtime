import { join } from "node:path";

import { loadRuntimeConfig } from "../../runtime/config.js";
import { RUNTIME_LOGS_DIR_NAME } from "../../runtime/config/layout.js";
import { loadRequestRunnerConfig } from "../../runtime/config/runner/loader.js";
import { createRequestModelPolicy } from "../../runtime/config/runner/model-policy.js";
import { configureDebugLogger } from "../../runtime/observability/debug-logger.js";
import { DEFAULT_MODEL_GATEWAY_URL } from "../../shared/constants.js";
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

export function configureModelGateway(
  options: ModelGatewayHandlerOptions,
): ModelGatewayPolicyConfig {
  const runtimeConfig = loadRuntimeConfig({ rootDir: process.cwd() });
  const modelPolicy =
    options.modelPolicy ??
    createRequestModelPolicy({
      platformPolicy: runtimeConfig.models,
      runnerConfig: loadRequestRunnerConfig({
        configPath: runtimeConfig.requestRunner.configPath,
      }),
    });

  configureDebugLogger({
    traceFile: resolveTraceFile({
      configuredPath: resolveConfiguredTraceFile("MODEL_GATEWAY_TRACE_FILE"),
      sharedDir: runtimeConfig.paths.sharedDir,
      segments: MODEL_GATEWAY_TRACE_FILE_SEGMENTS,
    }),
    enabled: runtimeConfig.logging?.enabled,
    rotation: runtimeConfig.logging?.rotation,
  });
  configureModelIoTrace({
    traceFile: resolveTraceFile({
      configuredPath: resolveConfiguredTraceFile(
        "MODEL_GATEWAY_MODEL_IO_TRACE_FILE",
      ),
      sharedDir: runtimeConfig.paths.sharedDir,
      segments: MODEL_IO_TRACE_FILE_SEGMENTS,
    }),
    enabled: runtimeConfig.logging?.enabled,
    rotation: runtimeConfig.logging?.rotation,
  });

  return modelPolicy;
}
