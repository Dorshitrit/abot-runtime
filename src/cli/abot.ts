import { join, resolve } from "node:path";

import { runAddRuntimeModel } from "../../scripts/add-runtime-model.js";
import { runInitRuntime } from "../../scripts/init-runtime.js";
import { runConfigureLongTermMemory } from "../../scripts/configure-long-term-memory.js";
import { resolveProviderAdapters } from "../model-gateway/server.js";
import { loadDotEnvFile } from "../shared/load-dotenv.js";
import { closeRuntimeSetupServices } from "../web-ui/runtime-setup-shutdown.js";
import { RuntimeSetupGateway } from "../web-ui/runtime-setup-gateway.js";
import { startWebUiServer } from "../web-ui/server.js";
import { resolveWebUiAddress } from "../web-ui/web-ui-address.js";
import { runHostCompanionCli } from "./host-companion.js";

function printHelp(): void {
  console.log(
    [
      "ABot Runtime",
      "",
      "Usage:",
      "  abot init --provider <provider> --model <model-id> [options]",
      "  abot add-model --profile <profile-id> --provider <provider> --model <model-id> [options]",
      "  abot memory <status|models|enable|disable> [options]",
      "  abot start",
      "  abot host <connect|status|disconnect|uninstall|run>",
      "",
      "Commands:",
      "  init       Create the first machine-local runtime configuration.",
      "  add-model  Add a provider/model profile without replacing existing ones.",
      "  memory     Configure passive long-term memory embeddings.",
      "  start      Start the local model gateway and Web UI.",
      "  host       Pair this computer with a local Docker Runtime.",
    ].join("\n"),
  );
}

async function runStart(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: abot start");
    return;
  }
  if (args.length > 0) {
    throw new Error(`unknown start argument: ${args[0]}`);
  }

  const rootDir = process.cwd();
  loadDotEnvFile(join(rootDir, ".env"));
  const webAddress = resolveWebUiAddress(process.env);
  const appDir = resolve(import.meta.dirname, "../web-ui/app");
  const providerAdapters = resolveProviderAdapters({});
  const gateway = new RuntimeSetupGateway({ rootDir, providerAdapters });
  try {
    await gateway.activate(process.env.LLM_RUNTIME_CONFIG_FILE);
  } catch {
    console.log(
      "Complete model setup in the Web UI to start the model gateway.",
    );
  }

  const webUi = startWebUiServer({
    appDir,
    rootDir,
    host: webAddress.listenHost,
    port: webAddress.port,
    setupCommandMode: "package",
    providerAdapters,
    onRuntimeSetup: (configPath) => gateway.activate(configPath),
    createRuntimeSetupRestorePoint: () => gateway.createRestorePoint(),
    checkRuntimeSetupActivation: (configPath) =>
      gateway.checkActivation(configPath),
  });
  console.log(`Open ${webAddress.browserUrl}`);

  await new Promise<void>((resolveExit, rejectExit) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void closeRuntimeSetupServices(
        () => webUi.close(),
        () => gateway.close(),
      ).then(() => resolveExit(), rejectExit);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export async function runAbotCli(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const [command, ...args] = argv;
  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    printHelp();
    return;
  }
  if (command === "init") {
    await runInitRuntime(args, { commandMode: "package" });
    return;
  }
  if (command === "add-model") {
    await runAddRuntimeModel(args, { commandMode: "package" });
    return;
  }
  if (command === "memory") {
    await runConfigureLongTermMemory(args, { commandMode: "package" });
    return;
  }
  if (command === "start") {
    await runStart(args);
    return;
  }
  if (command === "host") {
    await runHostCompanionCli(args);
    return;
  }
  throw new Error(`unknown command: ${command}`);
}
