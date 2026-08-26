import {
  createRuntimeApplication,
  loadRuntimeConfig,
} from "./src/runtime/index.js";

async function main() {
  const config = loadRuntimeConfig();
  const runtime = createRuntimeApplication(config);
  const handle = runtime.host.start();

  console.log(`runtime bridge client started: ${config.runtimeId}`);

  process.on("SIGINT", async () => {
    await handle.stop();
    process.exit(0);
  });
}

main();
