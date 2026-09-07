import {
  createLocalRuntimeApplication,
  loadRuntimeConfig,
} from "./src/runtime/index.js";
import { startAgentBridge } from "./src/bridge/start-agent-bridge.js";

async function main() {
  const config = loadRuntimeConfig();
  const runtime = createLocalRuntimeApplication(config);
  await runtime.start();
  const handle = startAgentBridge({
    runtimeConfig: config,
    runtimeId: config.runtimeId,
    url: config.agentBridgeUrl,
    token: config.agentBridgeToken,
    requestHandler: runtime.requests,
    sessionStore: runtime.services.sessions,
    attachmentStore: runtime.services.attachments,
  });

  console.log(`runtime bridge client started: ${config.runtimeId}`);

  const stopRuntime = async () => {
    await Promise.all([handle.stop(), runtime.stop()]);
    process.exit(0);
  };
  process.on("SIGINT", stopRuntime);
  process.on("SIGTERM", stopRuntime);
}

main();
