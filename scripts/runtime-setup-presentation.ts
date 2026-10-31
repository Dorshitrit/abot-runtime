export type RuntimeSetupCommandMode = "source" | "package";

function commandForMode(
  mode: RuntimeSetupCommandMode,
  sourceCommand: string,
  packageCommand: string,
): string {
  return mode === "package" ? packageCommand : sourceCommand;
}

export function getInitUsage(mode: RuntimeSetupCommandMode): string {
  const command = commandForMode(mode, "npm run init --", "npx abot init");
  return `Usage: ${command} --provider <provider-adapter> --model <model-id> [--label <display-name>] [--base-url <provider-origin>] [--context-window <tokens>] [--supports-thinking <true|false>] [--reasoning-budget <tokens|server-default>] [--api-key-env <name>] [--prompt-cache <true|false>] [--force] [--root <dir>]\n--prompt-cache true: Optimize caching for Execution Agent decisions on OpenAI API models supporting explicit boundaries (GPT-5.6+ or compatible). Omitted/false keeps provider defaults.`;
}

export function getAddModelUsage(mode: RuntimeSetupCommandMode): string {
  const command = commandForMode(
    mode,
    "npm run add-model --",
    "npx abot add-model",
  );
  return `Usage: ${command} --profile <profile-id> --provider <provider-adapter> --model <model-id> [--label <display-name>] [--base-url <provider-origin>] [--context-window <tokens>] [--supports-thinking <true|false>] [--reasoning-budget <tokens|server-default>] [--api-key-env <name>] [--prompt-cache <true|false>] [--default] [--root <dir>]\n--prompt-cache true: Optimize caching for Execution Agent decisions on OpenAI API models supporting explicit boundaries (GPT-5.6+ or compatible). Omitted/false keeps provider defaults.`;
}

export function getMissingInitializationInstruction(
  mode: RuntimeSetupCommandMode,
): string {
  return commandForMode(
    mode,
    "run npm run init first",
    "run npx abot init first",
  );
}

export function getInitNextSteps(
  mode: RuntimeSetupCommandMode,
): readonly string[] {
  if (mode === "package") {
    return [
      "Getting started:",
      "1. Review .env and local/*.config.json for your machine.",
      "2. Set provider credentials in .env when required.",
      "3. Start ABot with npx abot start.",
    ];
  }
  return [
    "Getting started:",
    "1. Review .env and local/*.config.json for your machine.",
    "2. Start npm run model-gateway.",
    "3. Start npm run dev in another terminal.",
    "4. Optional: start npm run web-ui for the local browser client.",
  ];
}

export function getRestartInstruction(mode: RuntimeSetupCommandMode): string {
  return commandForMode(
    mode,
    "restart the model gateway and Web UI to load the new profile",
    "restart ABot with npx abot start to load the new profile",
  );
}
