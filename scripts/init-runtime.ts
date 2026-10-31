import { supportsProviderAddress } from "./runtime-setup-provider-options.js";
import { requirePackagedSetupProvider } from "../src/cli/setup-provider-validation.js";
import { warnSavedOllamaModel } from "../src/cli/setup-model-warning.js";
import {
  parseSetupCommandOptions,
  requireSetupCommandProviderOptions,
  type SetupCommandOptions,
} from "./runtime-setup-command-options.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { planInitRuntimeFiles } from "./init-runtime-plan.js";
import { validateInitRuntimeFiles } from "./init-runtime-validation.js";
import { initializeConfiguredRuntimeDirectories } from "./runtime-setup-directories.js";
import {
  parseBaseUrl,
  parseProvider,
  resolveRuntimePackageRoot,
  type Provider,
} from "./runtime-setup-files.js";
import {
  getInitNextSteps,
  getInitUsage,
  type RuntimeSetupCommandMode,
} from "./runtime-setup-presentation.js";

type InitOptions = SetupCommandOptions & {
  rootDir: string;
  provider: Provider;
  model: string;
  baseUrl?: string;
  force: boolean;
};

type RunInitRuntimeOptions = Readonly<{
  commandMode?: RuntimeSetupCommandMode;
}>;

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
  const shared = parseSetupCommandOptions(argv);
  argv = shared.argv;
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
  if (baseUrl && !supportsProviderAddress(provider)) {
    throw new Error(
      "--base-url is supported only with --provider ollama or llamacpp",
    );
  }

  requireSetupCommandProviderOptions(provider, shared);
  return { ...shared, rootDir, provider, model, baseUrl, force };
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
      "--base-url configures the Ollama or llama.cpp origin reachable from the Runtime.",
    ].join("\n"),
  );
}

export async function runInitRuntime(
  argv: string[] = process.argv.slice(2),
  runOptions: RunInitRuntimeOptions = {},
): Promise<void> {
  const commandMode = runOptions.commandMode ?? "source";
  const options = parseArgs(argv, commandMode);
  requirePackagedSetupProvider(options.provider, commandMode);
  const templateRoot = resolveRuntimePackageRoot(import.meta.dirname);
  const files = await planInitRuntimeFiles(options, templateRoot);
  await validateInitRuntimeFiles(options.rootDir, files);

  for (const file of files) {
    const needsInitFileWrite =
      file.status !== "kept" || file.envLineChanged === true;
    if (!needsInitFileWrite) continue;
    const targetPath = join(options.rootDir, file.relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.content, {
      encoding: "utf-8",
      flag: file.status === "created" ? "wx" : "w",
    });
  }
  const configPath = join(options.rootDir, "local/runtime.config.json");

  const runtimeDirectories = await initializeConfiguredRuntimeDirectories(
    options.rootDir,
    configPath,
  );

  console.log(
    [
      "abot initialized",
      `root: ${options.rootDir}`,
      `provider: ${options.provider}`,
      `model: ${options.model}`,
      ...(options.baseUrl ? [`base URL: ${options.baseUrl}`] : []),
      ...files.map(
        (file) =>
          `${file.relativePath}: ${file.status}${file.envLineChanged ? " + config pointer" : ""}`,
      ),
      `initialized runtime directories: ${runtimeDirectories.map((directory) => relative(options.rootDir, directory) || ".").join(", ")}`,
      "",
      ...getInitNextSteps(commandMode),
    ].join("\n"),
  );
  await warnSavedOllamaModel({ commandMode, rootDir: options.rootDir, configPath, profileId: "default" });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runInitRuntime().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
