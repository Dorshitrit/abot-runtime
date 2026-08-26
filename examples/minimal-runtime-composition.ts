import {
  createDefaultRuntimeDependencies,
  loadRuntimeConfig,
} from "@abot-ai/runtime/runtime";

const config = loadRuntimeConfig({ rootDir: process.cwd() });
const runtime = createDefaultRuntimeDependencies(config);

console.log({
  runtimeId: config.runtimeId,
  modelGatewayUrl: config.modelGatewayUrl,
  paths: {
    runtimeDir: config.paths.runtimeDir,
    attachmentsDir: config.paths.attachmentsDir,
  },
  dependencies: {
    host: Boolean(runtime.host),
    sessions: Boolean(runtime.sessions),
    attachments: Boolean(runtime.attachments),
    tools: Boolean(runtime.tools),
    models: Boolean(runtime.models),
    events: Boolean(runtime.events),
  },
});
