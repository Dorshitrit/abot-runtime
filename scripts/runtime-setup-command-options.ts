import { parseContextWindowTokens } from "./runtime-setup-files.js";
import { parseProviderCredentialEnvironment } from "./runtime-setup-provider-options.js";
import { parseCliReasoningBudget, parseSetupModelOptions, type SetupModelOptions } from "./runtime-setup-model-options.js";

export type SetupCommandOptions = Readonly<{
  contextWindowTokens?: number;
  apiKeyEnv?: string;
  modelOptions: SetupModelOptions;
}>;

/** Reads shared setup flags before the existing command-specific argument parser. */
export function parseSetupCommandOptions(args: string[]): SetupCommandOptions & { argv: string[] } {
  const argv: string[] = [];
  const options: Record<string, unknown> = {};
  let contextWindowTokens: number | undefined;
  let apiKeyEnv: string | undefined;
  const flags = ["--supports-thinking", "--reasoning-budget", "--context-window", "--api-key-env"];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const flag = arg.split("=")[0]!;
    if (!flags.includes(flag)) {
      argv.push(arg);
      continue;
    }
    const hasInlineValue = arg.startsWith(flag + "=");
    const value = hasInlineValue ? arg.slice(flag.length + 1) : args[++index];
    if (!value || value.startsWith("--")) throw new Error(flag + " requires a value");
    if (flag === "--supports-thinking") {
      if (value !== "true" && value !== "false")
        throw new Error("--supports-thinking must be true or false");
      options.supportsThinking = value === "true";
    }
    if (flag === "--reasoning-budget") options.reasoningBudget = parseCliReasoningBudget(value);
    if (flag === "--context-window") contextWindowTokens = parseContextWindowTokens(Number(value));
    if (flag === "--api-key-env") apiKeyEnv = parseProviderCredentialEnvironment(value);
  }
  return { argv, contextWindowTokens, apiKeyEnv, modelOptions: parseSetupModelOptions(options) };
}

export function requireSetupCommandProviderOptions(provider: string, options: SetupCommandOptions): void {
  if (options.apiKeyEnv && provider !== "llamacpp")
    throw new Error("--api-key-env is supported only with --provider llamacpp");
  if (options.modelOptions.reasoningBudget && provider !== "llamacpp")
    throw new Error("--reasoning-budget is supported only with --provider llamacpp");
}
