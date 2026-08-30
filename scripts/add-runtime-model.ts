import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseRequestRunnerConfig } from "../src/runtime/config/runner/versioned-config.js";

import {
  buildModelConfig,
  buildProviderConfig,
  isRecord,
  parseBaseUrl,
  parseProvider,
  readJsonObject,
  resolveRuntimePackageRoot,
  writeJsonObject,
  type JsonObject,
  type Provider,
} from "./runtime-setup-files.js";
import {
  getAddModelUsage,
  getMissingInitializationInstruction,
  getRestartInstruction,
  type RuntimeSetupCommandMode,
} from "./runtime-setup-presentation.js";

type AddModelOptions = Readonly<{
  rootDir: string;
  provider: Provider;
  model: string;
  profile: string;
  baseUrl?: string;
  setDefault: boolean;
}>;

type RunAddRuntimeModelOptions = Readonly<{
  commandMode?: RuntimeSetupCommandMode;
}>;

const RUNTIME_CONFIG_FILE = "local/runtime.config.json";
const REQUEST_RUNNER_CONFIG_FILE = "local/request-runner.config.json";
const MODEL_TEMPLATE_FILE = "examples/models/default.config.json";

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseProfile(value: string): string {
  const profile = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(profile)) {
    throw new Error(
      "--profile must start with a letter or number and use only letters, numbers, dot, underscore, or dash",
    );
  }
  return profile;
}

function parseArgs(
  argv: string[],
  commandMode: RuntimeSetupCommandMode,
): AddModelOptions {
  let rootDir = process.cwd();
  let provider: Provider | undefined;
  let model: string | undefined;
  let profile: string | undefined;
  let baseUrl: string | undefined;
  let setDefault = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--default") {
      setDefault = true;
      continue;
    }
    if (arg === "--provider") {
      provider = parseProvider(requireValue(argv, index, "--provider"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      provider = parseProvider(arg.slice("--provider=".length));
      continue;
    }
    if (arg === "--model") {
      model = requireValue(argv, index, "--model");
      index += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length).trim();
      if (!model) throw new Error("--model requires a value");
      continue;
    }
    if (arg === "--profile") {
      profile = parseProfile(requireValue(argv, index, "--profile"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      profile = parseProfile(arg.slice("--profile=".length));
      continue;
    }
    if (arg === "--base-url") {
      baseUrl = parseBaseUrl(requireValue(argv, index, "--base-url"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      baseUrl = parseBaseUrl(arg.slice("--base-url=".length));
      continue;
    }
    if (arg === "--root") {
      rootDir = resolve(requireValue(argv, index, "--root"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      const value = arg.slice("--root=".length).trim();
      if (!value) throw new Error("--root requires a path");
      rootDir = resolve(value);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp(commandMode);
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!provider) throw new Error("--provider is required");
  if (!model) throw new Error("--model is required");
  if (!profile) throw new Error("--profile is required");
  if (baseUrl && provider !== "ollama") {
    throw new Error("--base-url is supported only with --provider ollama");
  }
  return { rootDir, provider, model, profile, baseUrl, setDefault };
}

function printHelp(commandMode: RuntimeSetupCommandMode): void {
  console.log(
    [
      getAddModelUsage(commandMode),
      "",
      "Adds one model profile without replacing existing providers or profiles.",
      "--default selects the new profile as the request-runner default; it does not remove existing configuration.",
    ].join("\n"),
  );
}

async function assertExists(
  path: string,
  label: string,
  commandMode: RuntimeSetupCommandMode,
): Promise<void> {
  try {
    await access(path, constants.F_OK);
  } catch {
    throw new Error(
      `${label} was not found; ${getMissingInitializationInstruction(commandMode)}`,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readConfigMap(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${key} must be a JSON object`);
  return value;
}

function mergeRuntimeConfig(
  runtimeConfig: JsonObject,
  options: AddModelOptions,
): Readonly<{ config: JsonObject; providerAdded: boolean }> {
  const models = readConfigMap(runtimeConfig, "models");
  const providers = readConfigMap(models, "providers");
  const profiles = readConfigMap(models, "profiles");
  if (profiles[options.profile] !== undefined) {
    throw new Error(
      `model profile already exists: ${options.profile}; no files were changed`,
    );
  }

  const existingProvider = providers[options.provider];
  if (existingProvider !== undefined) {
    if (
      !isRecord(existingProvider) ||
      existingProvider.type !== options.provider
    ) {
      throw new Error(
        `provider id is already configured with a different adapter: ${options.provider}; no files were changed`,
      );
    }
    if (
      options.provider === "ollama" &&
      options.baseUrl &&
      existingProvider.baseUrl !== options.baseUrl
    ) {
      throw new Error(
        `provider ${options.provider} already uses a different base URL; no files were changed`,
      );
    }
  }

  return {
    providerAdded: existingProvider === undefined,
    config: {
      ...runtimeConfig,
      models: {
        ...models,
        providers: {
          ...providers,
          ...(existingProvider === undefined
            ? {
                [options.provider]: buildProviderConfig(
                  options.provider,
                  options.baseUrl,
                ),
              }
            : {}),
        },
        profiles: {
          ...profiles,
          [options.profile]: {
            configRef: `./models/${options.profile}.config.json`,
          },
        },
      },
    },
  };
}

function selectDefaultProfile(
  runnerConfig: JsonObject,
  profile: string,
): JsonObject {
  const models = readConfigMap(runnerConfig, "models");
  const defaults = readConfigMap(models, "defaults");
  return {
    ...runnerConfig,
    models: {
      ...models,
      defaults: {
        ...defaults,
        profileId: profile,
      },
    },
  };
}

export async function runAddRuntimeModel(
  argv: string[] = process.argv.slice(2),
  runOptions: RunAddRuntimeModelOptions = {},
): Promise<void> {
  const commandMode = runOptions.commandMode ?? "source";
  const options = parseArgs(argv, commandMode);
  const runtimeConfigPath = join(options.rootDir, RUNTIME_CONFIG_FILE);
  const runnerConfigPath = join(options.rootDir, REQUEST_RUNNER_CONFIG_FILE);
  const modelConfigPath = join(
    options.rootDir,
    "local",
    "models",
    `${options.profile}.config.json`,
  );

  await assertExists(runtimeConfigPath, RUNTIME_CONFIG_FILE, commandMode);
  await assertExists(runnerConfigPath, REQUEST_RUNNER_CONFIG_FILE, commandMode);
  if (await pathExists(modelConfigPath)) {
    throw new Error(
      `model config already exists: local/models/${options.profile}.config.json; no files were changed`,
    );
  }

  const [runtimeConfig, runnerConfig, modelTemplate] = await Promise.all([
    readJsonObject(runtimeConfigPath),
    readJsonObject(runnerConfigPath),
    readJsonObject(
      join(resolveRuntimePackageRoot(import.meta.dirname), MODEL_TEMPLATE_FILE),
    ),
  ]);
  if (options.setDefault) {
    parseRequestRunnerConfig(runnerConfig, runnerConfigPath);
  }
  const merged = mergeRuntimeConfig(runtimeConfig, options);
  const nextRunnerConfig = options.setDefault
    ? selectDefaultProfile(runnerConfig, options.profile)
    : runnerConfig;
  const modelConfig = buildModelConfig(
    modelTemplate,
    options.provider,
    options.model,
  );

  await mkdir(dirname(modelConfigPath), { recursive: true });
  await writeJsonObject(modelConfigPath, modelConfig, { exclusive: true });
  await writeJsonObject(runtimeConfigPath, merged.config);
  if (options.setDefault) {
    await writeJsonObject(runnerConfigPath, nextRunnerConfig);
  }

  console.log(
    [
      "model added",
      `profile: ${options.profile}`,
      `provider: ${options.provider} (${merged.providerAdded ? "added" : "kept"})`,
      `model: ${options.model}`,
      `default profile: ${options.setDefault ? options.profile : "unchanged"}`,
      ...(options.provider === "openai"
        ? ["credential: set OPENAI_API_KEY in .env"]
        : []),
      getRestartInstruction(commandMode),
    ].join("\n"),
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runAddRuntimeModel().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
