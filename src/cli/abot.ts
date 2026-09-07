import type { Server } from "node:http";
import { join, resolve } from "node:path";

import { runAddRuntimeModel } from "../../scripts/add-runtime-model.js";
import { runInitRuntime } from "../../scripts/init-runtime.js";
import { runConfigureLongTermMemory } from "../../scripts/configure-long-term-memory.js";
import {
  createModelGatewayServer,
  resolveProviderAdapters,
  resolveModelGatewayPort,
} from "../model-gateway/server.js";
import { loadDotEnvFile } from "../shared/load-dotenv.js";
import { closeHttpServerImmediately } from "../shared/http-server-shutdown.js";
import { startWebUiServer } from "../web-ui/server.js";
import { resolveWebUiAddress } from "../web-ui/web-ui-address.js";

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
      "",
      "Commands:",
      "  init       Create the first machine-local runtime configuration.",
      "  add-model  Add a provider/model profile without replacing existing ones.",
      "  memory     Configure passive long-term memory embeddings.",
      "  start      Start the local model gateway and Web UI.",
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
  let gateway: Server | undefined;

  try {
    gateway = createModelGatewayServer({ providerAdapters });
    const gatewayPort = resolveModelGatewayPort();
    gateway.listen(gatewayPort, "127.0.0.1", () => {
      console.log(`model gateway listening on http://127.0.0.1:${gatewayPort}`);
    });
  } catch (error) {
    console.warn(
      `model gateway not started: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.warn("Complete model setup, stop ABot, and run abot start again.");
  }

  const webUi = startWebUiServer({
    appDir,
    rootDir,
    host: webAddress.listenHost,
    port: webAddress.port,
    setupCommandMode: "package",
    providerAdapters,
  });
  console.log(`Open ${webAddress.browserUrl}`);

  await new Promise<void>((resolveExit, rejectExit) => {
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void Promise.all([
        webUi.close(),
        ...(gateway ? [closeHttpServerImmediately(gateway)] : []),
      ]).then(() => resolveExit(), rejectExit);
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
  throw new Error(`unknown command: ${command}`);
}
