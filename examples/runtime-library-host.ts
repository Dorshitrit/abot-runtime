import {
  createDefaultRuntimeDependencies,
  loadRuntimeConfig,
} from "@abot-ai/runtime/runtime";

const config = loadRuntimeConfig({ rootDir: process.cwd() });
const runtime = createDefaultRuntimeDependencies(config);

const handle = runtime.host.start({
  runtimeConfig: config,
  runtimeId: config.runtimeId,
  agentBridgeUrl: config.agentBridgeUrl,
  agentBridgeToken: config.agentBridgeToken,
  eventSinkFactory: runtime.events,
  modelGatewayClient: runtime.models,
  sessionStore: runtime.sessions,
  attachmentStore: runtime.attachments,
  toolRegistry: runtime.tools,
});

process.on("SIGINT", async () => {
  await handle.stop();
  process.exit(0);
});
