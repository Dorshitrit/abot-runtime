import { requireChatGptAccountRef } from "../src/provider-auth/chatgpt/contracts.js";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { defaultProviderAddress, parseProviderCredentialEnvironment } from "./runtime-setup-provider-options.js";
import { applySetupPromptCache } from "./runtime-setup-prompt-cache.js";
import { buildSetupModelReasoning, type SetupModelOptions } from "./runtime-setup-model-options.js";

export type Provider = string;
export type JsonObject = Record<string, unknown>;

export const DEFAULT_ROOT_RESPONSE_METHODOLOGY_FILES = Object.freeze([
  "methodologies/response-ux.md",
  "methodologies/memory-informed-response.md",
]);

export function resolveRuntimePackageRoot(startDir: string): string {
  let current = resolve(startDir);
  while (true) {
    if (
      existsSync(join(current, "examples", "runtime.config.example.json")) &&
      existsSync(join(current, "package.json"))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("could not locate the @abot-ai/runtime package root");
    }
    current = parent;
  }
}

export function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseProvider(value: string): Provider {
  const provider = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(provider)) {
    throw new Error("--provider must be a provider adapter identifier");
  }
  return provider;
}

export function parseBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("--base-url must be a valid HTTP or HTTPS origin");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== "/")
  ) {
    throw new Error("--base-url must be a valid HTTP or HTTPS origin");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export async function readJsonObject(path: string): Promise<JsonObject> {
  const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed;
}

export async function writeJsonObject(
  path: string,
  value: JsonObject,
  options: Readonly<{ exclusive?: boolean }> = {},
): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
    ...(options.exclusive ? { flag: "wx" } : {}),
  });
}

export function buildProviderConfig(
  provider: Provider,
  baseUrl?: string,
  apiKeyEnv?: string,
  accountRef?: string,
): JsonObject {
  if (provider === "openai-chatgpt")
    return { type: provider, settings: { accountRef: requireChatGptAccountRef(accountRef) } };
  if (provider === "openai") {
    return {
      type: "openai",
      apiKeyEnv: "OPENAI_API_KEY",
    };
  }
  if (provider === "ollama") {
    return {
      type: "ollama",
      baseUrl: baseUrl ?? "http://127.0.0.1:11434",
    };
  }
  if (provider === "llamacpp") {
    const credential = parseProviderCredentialEnvironment(apiKeyEnv);
    return {
      type: "llamacpp",
      baseUrl: baseUrl ?? defaultProviderAddress(provider),
      ...(credential ? { apiKeyEnv: credential } : {}),
    };
  }
  return { type: provider };
}

export function buildModelConfig(
  template: JsonObject,
  provider: Provider,
  model: string,
  contextWindowTokens?: number,
  modelOptions: SetupModelOptions = {},
  label?: string,
): JsonObject {
  const context = isRecord(template.context) ? template.context : {};
  const tokenEstimation = isRecord(context.tokenEstimation)
    ? context.tokenEstimation
    : {};
  const calibration = isRecord(template.calibration) ? template.calibration : {};
  const compaction = isRecord(calibration["context.compact"])
    ? calibration["context.compact"]
    : {};
  const generation = isRecord(compaction.generation) ? compaction.generation : {};
  const rawPayload = isRecord(calibration["toolPayload.raw"])
    ? calibration["toolPayload.raw"]
    : {};
  const shouldApplyOllamaSetupCalibration = provider === "ollama";
  const isOpenAIResponsesSetup = provider === "openai" || provider === "openai-chatgpt";
  const shouldApplyOpenAiStepTimeouts = isOpenAIResponsesSetup;
  const modelConfig = {
    ...template,
    ...buildSetupModelReasoning(
      provider,
      isRecord(template.generation) ? template.generation : {},
      modelOptions,
    ),
    ...(shouldApplyOllamaSetupCalibration
      ? {
          calibration: {
            ...calibration,
            "context.compact": {
              ...compaction,
              generation: {
                temperature: 0,
                reasoningEffort: "none",
                ...generation,
              },
            },
          },
        }
      : {}),
    label: label ?? model,
    provider,
    model,
    ...(contextWindowTokens !== undefined
      ? { contextWindowTokens: parseContextWindowTokens(contextWindowTokens) }
      : {}),
    ...(isOpenAIResponsesSetup
      ? {
          execution: {
            policy: "execution-agent-v1",
          },
        }
      : {}),
    context: {
      ...context,
      ...(shouldApplyOllamaSetupCalibration
        ? {
            tokenEstimation: {
              asciiCharactersPerToken: 3,
              nonAsciiBytesPerToken: 2,
              messageOverheadTokens: 6,
              ...tokenEstimation,
            },
          }
        : {}),
      formatTokenAccounting: {
        mode: shouldApplyOllamaSetupCalibration ? "none" : "estimate",
      },
    },
  };
  applySetupPromptCache(modelConfig, provider, modelOptions.promptCache);
  if (!shouldApplyOpenAiStepTimeouts) return modelConfig;
  return {
    ...modelConfig,
    calibration: {
      ...calibration,
      "context.compact": { timeoutMs: 300_000, ...compaction },
      "toolPayload.raw": { timeoutMs: 300_000, ...rawPayload },
    },
  };
}

export function parseContextWindowTokens(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(
      "Context window must be a positive whole number of tokens.",
    );
  return value;
}

export async function readDefaultContextWindowTokens(): Promise<number> {
  const template = await readJsonObject(
    join(
      resolveRuntimePackageRoot(import.meta.dirname),
      "examples/models/default.config.json",
    ),
  );
  const value = parseContextWindowTokens(template.contextWindowTokens);
  if (value === undefined)
    throw new Error("The model template is missing its context window.");
  return value;
}
