import { defineRuntimePlugin } from "../../../src/plugin-sdk/index.js";
import { createSystemHandlers } from "../../../src/plugin-sdk/computer-access.js";
import { prepareSystemRequestModules } from "./request-system-modules.js";
import { unboundComputerHandlers } from "./computer/request-modules.js";

export default defineRuntimePlugin(({ rootDir }) => ({
  handlers: { ...createSystemHandlers(), ...unboundComputerHandlers() },
  prepareRequest: (modules, preparation) =>
    prepareSystemRequestModules(rootDir, modules, {}, preparation),
}));
