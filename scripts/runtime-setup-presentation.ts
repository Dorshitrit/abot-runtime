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
  return `Usage: ${command} --provider <provider-adapter> --model <model-id> [--base-url <provider-origin>] [--force] [--root <dir>]`;
}

export function getAddModelUsage(mode: RuntimeSetupCommandMode): string {
  const command = commandForMode(
    mode,
    "npm run add-model --",
    "npx abot add-model",
  );
  return `Usage: ${command} --profile <profile-id> --provider <provider-adapter> --model <model-id> [--base-url <provider-origin>] [--default] [--root <dir>]`;
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
