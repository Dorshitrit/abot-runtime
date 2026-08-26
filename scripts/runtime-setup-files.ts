import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type Provider = string;
export type JsonObject = Record<string, unknown>;

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
): JsonObject {
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
  return { type: provider };
}

export function buildModelConfig(
  template: JsonObject,
  provider: Provider,
  model: string,
): JsonObject {
  const context = isRecord(template.context) ? template.context : {};
  return {
    ...template,
    label: model,
    provider,
    model,
    ...(provider === "openai"
      ? {
          execution: {
            policy: "execution-agent-v1",
          },
        }
      : {}),
    context: {
      ...context,
      formatTokenAccounting: {
        mode: provider === "ollama" ? "none" : "estimate",
      },
    },
  };
}
