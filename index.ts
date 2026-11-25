import {
  createLocalRuntimeApplication,
  loadRuntimeConfig,
} from "./src/runtime/index.js";
import { resolveConfiguredRuntimeConnection } from "./src/bridge/configured-runtime-connection.js";
import { recoverRuntimeSetupEdit } from "./src/web-ui/local-runtime/runtime-setup-edit-recovery.js";

async function main() {
  await recoverRuntimeSetupEdit(process.cwd());
  const config = loadRuntimeConfig();
  const bridge = resolveConfiguredRuntimeConnection(config, config.runtimeId, process.cwd());
  const runtime = createLocalRuntimeApplication(config, { bridge });
  await runtime.start();
  console.log(`runtime started: ${config.runtimeId}`);

  const stopRuntime = async () => {
    await runtime.stop();
    process.exit(0);
  };
  process.on("SIGINT", stopRuntime);
  process.on("SIGTERM", stopRuntime);
}

await main();
