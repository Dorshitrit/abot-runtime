import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildModelConfig,
  buildProviderConfig,
  DEFAULT_ROOT_RESPONSE_METHODOLOGY_FILES,
  isRecord,
  parseBaseUrl,
  parseProvider,
  readJsonObject,
  resolveRuntimePackageRoot,
  writeJsonObject,
  type Provider,
} from "./runtime-setup-files.js";
import {
  getInitNextSteps,
  getInitUsage,
  type RuntimeSetupCommandMode,
} from "./runtime-setup-presentation.js";

type InitOptions = {
  rootDir: string;
  provider: Provider;
  model: string;
  baseUrl?: string;
  force: boolean;
};

type RunInitRuntimeOptions = Readonly<{
  commandMode?: RuntimeSetupCommandMode;
}>;

const ENV_FILE = ".env";
const ENV_EXAMPLE_FILE = "examples/env.example";
const LOCAL_CONFIG_FILE = "local/runtime.config.json";
const LOCAL_REQUEST_RUNNER_CONFIG_FILE = "local/request-runner.config.json";
const LOCAL_MODEL_CONFIG_FILE = "local/models/default.config.json";
const CONFIG_EXAMPLE_FILE = join("examples", "runtime.config.example.json");
const REQUEST_RUNNER_CONFIG_EXAMPLE_FILE = join(
  "examples",
  "request-runner.config.example.json",
);
const MODEL_CONFIG_EXAMPLE_FILE = join(
  "examples",
  "models",
  "default.config.json",
);
const REQUIRED_ENV_LINE = "LLM_RUNTIME_CONFIG_FILE=local/runtime.config.json";
const RUNTIME_DIRS = [
  join(".runtime", "compiled"),
  join(".runtime", "shared", "logs"),
  join(".runtime", "prod"),
  join(".runtime", "prod", "sandbox"),
  join(".runtime", "prod", "sessions"),
  join(".runtime", "dev"),
  join(".runtime", "dev", "sandbox"),
  join(".runtime", "dev", "sessions"),
];

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(
  argv: string[],
  commandMode: RuntimeSetupCommandMode,
): InitOptions {
  let rootDir = process.cwd();
  let provider: Provider | undefined;
  let model: string | undefined;
  let baseUrl: string | undefined;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--provider") {
      provider = parseProvider(requireValue(argv, index, "--provider"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      provider = parseProvider(arg.slice("--provider=".length).trim());
      continue;
    }
    if (arg === "--model") {
      model = requireValue(argv, index, "--model");
      index += 1;
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length).trim();
      if (!model) {
        throw new Error("--model requires a value");
      }
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
      if (!value) {
        throw new Error("--root requires a path");
      }
      rootDir = resolve(value);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp(commandMode);
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!provider) {
    throw new Error("--provider is required");
  }
  if (!model) {
    throw new Error("--model is required");
  }
  if (baseUrl && provider !== "ollama") {
    throw new Error("--base-url is supported only with --provider ollama");
  }

  return { rootDir, provider, model, baseUrl, force };
}

function printHelp(commandMode: RuntimeSetupCommandMode): void {
  console.log(
    [
      getInitUsage(commandMode),
      "",
      "Creates local runtime starter files without committing secrets:",
      "- .env",
      "- local/runtime.config.json",
      "- local/request-runner.config.json",
      "- local/models/default.config.json",
      "- methodologies for root response authoring",
      "- .runtime/compiled",
      "- .runtime/shared/logs",
      "- .runtime/prod and .runtime/dev",
      "",
      "Both --provider and --model are required; the runtime has no built-in model choice.",
      "--base-url configures the Ollama origin when Ollama runs outside the runtime host.",
    ].join("\n"),
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeIfMissing(params: {
  sourcePath: string;
  targetPath: string;
  force: boolean;
}): Promise<"created" | "overwritten" | "kept"> {
  const targetExists = await exists(params.targetPath);
  if (targetExists && !params.force) {
    return "kept";
  }
  await mkdir(dirname(params.targetPath), { recursive: true });
  await copyFile(params.sourcePath, params.targetPath);
  return targetExists ? "overwritten" : "created";
}

function ensureEnvLineContent(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const hasConfigLine = lines.some((line) =>
    line.trim().startsWith("LLM_RUNTIME_CONFIG_FILE="),
  );
  if (hasConfigLine) {
    return raw.endsWith("\n") ? raw : `${raw}\n`;
  }
  const terminated = raw.endsWith("\n") ? raw : `${raw}\n`;
  return `${terminated}${REQUIRED_ENV_LINE}\n`;
}

async function ensureEnvLine(envPath: string): Promise<boolean> {
  const raw = await readFile(envPath, "utf-8");
  const next = ensureEnvLineContent(raw);
  if (next === raw) {
    return false;
  }
  await writeFile(envPath, next, "utf-8");
  return true;
}

async function configureRuntimeProvider(
  configPath: string,
  provider: Provider,
  baseUrl?: string,
): Promise<void> {
  const config = await readJsonObject(configPath);
  const models = isRecord(config.models) ? config.models : {};
  const { defaults: _ignoredDefaults, ...modelSettings } = models;
  const providers = {
    [provider]: buildProviderConfig(provider, baseUrl),
  };

  config.models = {
    ...modelSettings,
    providers,
    profiles: {
      default: {
        configRef: "./models/default.config.json",
      },
    },
  };
  await writeJsonObject(configPath, config);
}

async function configureModelProfile(
  configPath: string,
  provider: Provider,
  model: string,
): Promise<void> {
  const config = await readJsonObject(configPath);
  await writeJsonObject(configPath, buildModelConfig(config, provider, model));
}

async function configureRunner(configPath: string): Promise<void> {
  const config = await readJsonObject(configPath);
  const models = isRecord(config.models) ? config.models : {};
  const defaults = isRecord(models.defaults) ? models.defaults : {};

  config.models = {
    ...models,
    defaults: {
      ...defaults,
      profileId: "default",
    },
  };
  await writeJsonObject(configPath, config);
}

export async function runInitRuntime(
  argv: string[] = process.argv.slice(2),
  runOptions: RunInitRuntimeOptions = {},
): Promise<void> {
  const commandMode = runOptions.commandMode ?? "source";
  const options = parseArgs(argv, commandMode);
  const templateRoot = resolveRuntimePackageRoot(import.meta.dirname);
  const envPath = join(options.rootDir, ENV_FILE);
  const configPath = join(options.rootDir, LOCAL_CONFIG_FILE);
  const requestRunnerConfigPath = join(
    options.rootDir,
    LOCAL_REQUEST_RUNNER_CONFIG_FILE,
  );
  const modelConfigPath = join(options.rootDir, LOCAL_MODEL_CONFIG_FILE);

  await mkdir(options.rootDir, { recursive: true });

  const envStatus = await writeIfMissing({
    sourcePath: join(templateRoot, ENV_EXAMPLE_FILE),
    targetPath: envPath,
    force: options.force,
  });
  const envLineChanged = await ensureEnvLine(envPath);
  const configStatus = await writeIfMissing({
    sourcePath: join(templateRoot, CONFIG_EXAMPLE_FILE),
    targetPath: configPath,
    force: options.force,
  });
  const requestRunnerConfigStatus = await writeIfMissing({
    sourcePath: join(templateRoot, REQUEST_RUNNER_CONFIG_EXAMPLE_FILE),
    targetPath: requestRunnerConfigPath,
    force: options.force,
  });
  const modelConfigStatus = await writeIfMissing({
    sourcePath: join(templateRoot, MODEL_CONFIG_EXAMPLE_FILE),
    targetPath: modelConfigPath,
    force: options.force,
  });
  const methodologyStatuses = await Promise.all(
    DEFAULT_ROOT_RESPONSE_METHODOLOGY_FILES.map(async (relativePath) => ({
      relativePath,
      status: await writeIfMissing({
        sourcePath: join(templateRoot, relativePath),
        targetPath: join(options.rootDir, relativePath),
        force: options.force,
      }),
    })),
  );

  if (configStatus !== "kept") {
    await configureRuntimeProvider(
      configPath,
      options.provider,
      options.baseUrl,
    );
  }
  if (requestRunnerConfigStatus !== "kept") {
    await configureRunner(requestRunnerConfigPath);
  }
  if (modelConfigStatus !== "kept") {
    await configureModelProfile(
      modelConfigPath,
      options.provider,
      options.model,
    );
  }

  await Promise.all(
    RUNTIME_DIRS.map((runtimeDir) =>
      mkdir(join(options.rootDir, runtimeDir), { recursive: true }),
    ),
  );

  console.log(
    [
      "abot initialized",
      `root: ${options.rootDir}`,
      `provider: ${options.provider}`,
      `model: ${options.model}`,
      ...(options.baseUrl ? [`base URL: ${options.baseUrl}`] : []),
      `.env: ${envStatus}${envLineChanged ? " + config pointer" : ""}`,
      `${LOCAL_CONFIG_FILE}: ${configStatus}`,
      `${LOCAL_REQUEST_RUNNER_CONFIG_FILE}: ${requestRunnerConfigStatus}`,
      `${LOCAL_MODEL_CONFIG_FILE}: ${modelConfigStatus}`,
      ...methodologyStatuses.map(
        ({ relativePath, status }) => `${relativePath}: ${status}`,
      ),
      "created runtime directories: .runtime/compiled, .runtime/shared/logs, .runtime/prod, .runtime/dev",
      "",
      ...getInitNextSteps(commandMode),
    ].join("\n"),
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runInitRuntime().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
