import {
  createModelGatewayServer,
  resolveModelGatewayPort,
} from "./server/index.js";

export * from "./server/index.js";
export {
  buildOllamaPayload,
  buildOllamaRawPayload,
  resolveFormat,
} from "./providers/ollama.js";

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = resolveModelGatewayPort();
  createModelGatewayServer().listen(port, () => {
    console.log(`MODEL GATEWAY RUNNING ${port}`);
  });
}
