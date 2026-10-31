import { requireSetupPromptCacheProvider } from "./runtime-setup-prompt-cache.js";
import { parseContextWindowTokens } from "./runtime-setup-files.js";
import { parseProviderCredentialEnvironment } from "./runtime-setup-provider-options.js";
import { parseCliReasoningBudget, parseSetupModelOptions, type SetupModelOptions } from "./runtime-setup-model-options.js";

export type SetupCommandOptions = Readonly<{
  contextWindowTokens?: number;
  apiKeyEnv?: string;
  label?: string;
  modelOptions: SetupModelOptions;
}>;

function parseSetupLabel(value: string): string {
  const label = value.trim();
  if (!label || label.length > 160) throw new Error("--label must contain 1 to 160 characters");
  if (/[\u0000-\u001f\u007f]/u.test(label)) throw new Error("--label must not contain control characters");
  return label;
}

/** Reads shared setup flags before the existing command-specific argument parser. */
export function parseSetupCommandOptions(args: string[]): SetupCommandOptions & { argv: string[] } {
  const argv: string[] = [];
  const options: Record<string, unknown> = {};
  let contextWindowTokens: number | undefined;
  let apiKeyEnv: string | undefined;
  let label: string | undefined;
  const flags = ["--supports-thinking", "--reasoning-budget", "--context-window", "--api-key-env", "--prompt-cache", "--label"];
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
    if (flag === "--prompt-cache") {
      if (value !== "true" && value !== "false")
        throw new Error("--prompt-cache must be true or false");
      options.promptCache = value === "true";
    }
    if (flag === "--reasoning-budget") options.reasoningBudget = parseCliReasoningBudget(value);
    if (flag === "--context-window") contextWindowTokens = parseContextWindowTokens(Number(value));
    if (flag === "--api-key-env") apiKeyEnv = parseProviderCredentialEnvironment(value);
    if (flag === "--label") label = parseSetupLabel(value);
  }
  return { argv, contextWindowTokens, apiKeyEnv, label, modelOptions: parseSetupModelOptions(options) };
}

export function requireSetupCommandProviderOptions(provider: string, options: SetupCommandOptions): void {
  requireSetupPromptCacheProvider(provider, options.modelOptions.promptCache);
  if (options.apiKeyEnv && provider !== "llamacpp")
    throw new Error("--api-key-env is supported only with --provider llamacpp");
  if (options.modelOptions.reasoningBudget && provider !== "llamacpp")
    throw new Error("--reasoning-budget is supported only with --provider llamacpp");
}
