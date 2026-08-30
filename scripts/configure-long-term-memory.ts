import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createLocalLongTermMemoryOnboardingService } from "../src/runtime/adapters/long-term-memory/onboarding-service.js";
import type { ModelProviderAdapterRegistry } from "../src/model-gateway/index.js";
import { resolveProviderAdapters } from "../src/model-gateway/server/index.js";
import { loadDotEnvFile } from "../src/shared/load-dotenv.js";
import type { RuntimeSetupCommandMode } from "./runtime-setup-presentation.js";

type MemoryCommand = "status" | "models" | "enable" | "disable";

type MemoryCommandOptions = Readonly<{
  command: MemoryCommand;
  rootDir: string;
  providerId?: string;
  model?: string;
  profileId?: string;
  emitClientEvents: boolean;
}>;

export async function runConfigureLongTermMemory(
  argv: string[] = process.argv.slice(2),
  options: Readonly<{
    commandMode?: RuntimeSetupCommandMode;
    providerAdapters?: ModelProviderAdapterRegistry;
  }> = {},
): Promise<void> {
  const commandMode = options.commandMode ?? "source";
  const input = parseMemoryCommand(argv, commandMode);
  loadDotEnvFile(join(input.rootDir, ".env"));
  const providerAdapters = resolveProviderAdapters({
    providerAdapters: options.providerAdapters,
  });
  const service = createLocalLongTermMemoryOnboardingService({
    rootDir: input.rootDir,
    providerAdapters,
    ...(process.env.LLM_RUNTIME_CONFIG_FILE
      ? { configPath: process.env.LLM_RUNTIME_CONFIG_FILE }
      : {}),
  });
  if (input.command === "status") {
    printJson(await service.status());
    return;
  }
  if (input.command === "models") {
    printJson(
      await service.discover({
        providerId: requireOption(input, "providerId"),
      }),
    );
    return;
  }
  if (input.command === "disable") {
    printJson(await service.disable());
    return;
  }
  printJson(
    await service.enable({
      providerId: requireOption(input, "providerId"),
      model: requireOption(input, "model"),
      ...(input.profileId ? { profileId: input.profileId } : {}),
      emitClientEvents: input.emitClientEvents,
    }),
  );
}

function parseMemoryCommand(
  argv: string[],
  commandMode: RuntimeSetupCommandMode,
): MemoryCommandOptions {
  const [commandValue, ...args] = argv;
  if (commandValue === "--help" || commandValue === "-h") {
    printHelp(commandMode);
    process.exit(0);
  }
  const command = parseCommand(commandValue);
  let rootDir = process.cwd();
  let providerId: string | undefined;
  let model: string | undefined;
  let profileId: string | undefined;
  let emitClientEvents = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--emit-events") {
      emitClientEvents = true;
      continue;
    }
    const parsed = readNamedArgument(args, index);
    index = parsed.nextIndex;
    if (parsed.name === "root") rootDir = resolve(parsed.value);
    else if (parsed.name === "provider") providerId = parsed.value;
    else if (parsed.name === "model") model = parsed.value;
    else if (parsed.name === "profile") profileId = parsed.value;
    else throw new Error(`unknown argument: --${parsed.name}`);
  }

  assertCommandArguments({ command, providerId, model });
  return {
    command,
    rootDir,
    emitClientEvents,
    ...(providerId ? { providerId } : {}),
    ...(model ? { model } : {}),
    ...(profileId ? { profileId } : {}),
  };
}

function parseCommand(value: string | undefined): MemoryCommand {
  if (["status", "models", "enable", "disable"].includes(value ?? "")) {
    return value as MemoryCommand;
  }
  throw new Error("memory command must be status, models, enable, or disable");
}

function readNamedArgument(
  args: string[],
  index: number,
): Readonly<{ name: string; value: string; nextIndex: number }> {
  const argument = args[index] ?? "";
  if (!argument.startsWith("--")) {
    throw new Error(`unknown argument: ${argument}`);
  }
  const separator = argument.indexOf("=");
  const name = argument.slice(2, separator > 0 ? separator : undefined);
  const inlineValue = separator > 0 ? argument.slice(separator + 1) : "";
  const value = inlineValue || args[index + 1]?.trim() || "";
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return { name, value, nextIndex: inlineValue ? index : index + 1 };
}

function assertCommandArguments(input: {
  command: MemoryCommand;
  providerId?: string;
  model?: string;
}): void {
  const needsProvider =
    input.command === "models" || input.command === "enable";
  if (needsProvider && !input.providerId) {
    throw new Error("--provider is required");
  }
  if (input.command === "enable" && !input.model) {
    throw new Error("--model is required");
  }
}

function requireOption<T extends "providerId" | "model">(
  input: MemoryCommandOptions,
  key: T,
): string {
  const value = input[key];
  if (!value) {
    throw new Error(`memory ${key} is required`);
  }
  return value;
}

function printHelp(commandMode: RuntimeSetupCommandMode): void {
  const prefix =
    commandMode === "package" ? "abot memory" : "npm run memory --";
  console.log(
    [
      `${prefix} status`,
      `${prefix} models --provider <provider-id>`,
      `${prefix} enable --provider <provider-id> --model <model-id> [--profile <profile-id>] [--emit-events]`,
      `${prefix} disable`,
      "",
      "Enable performs a real embedding probe before changing runtime config.",
      "The provider must already exist under models.providers.",
    ].join("\n"),
  );
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  runConfigureLongTermMemory().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
