import { defineRuntimePlugin } from "../../../src/plugin-sdk/index.js";
import { createSystemHandlers } from "./handlers.js";
import { prepareSystemRequestModules } from "./request-system-modules.js";

export default defineRuntimePlugin(({ rootDir }) => ({
  handlers: createSystemHandlers(),
  prepareRequest: (modules) => prepareSystemRequestModules(rootDir, modules),
}));
