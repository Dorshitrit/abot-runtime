import { pathToFileURL } from "node:url";
import { recoverRuntimeSetupEdit } from "../web-ui/local-runtime/runtime-setup-edit-recovery.js";
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

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  await recoverRuntimeSetupEdit(process.cwd());
  const port = resolveModelGatewayPort();
  createModelGatewayServer().listen(port, () => {
    console.log(`MODEL GATEWAY RUNNING ${port}`);
  });
}
