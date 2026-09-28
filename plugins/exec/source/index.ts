import { defineRuntimePlugin } from "../../../src/plugin-sdk/index.js";

import { createExecHandlers } from "./handlers.js";
import { readExecSettings } from "./settings.js";
import { createExecAdapter } from "./validation.js";

export default defineRuntimePlugin((context) => ({
  handlers: createExecHandlers(context, readExecSettings(context.config)),
  prepareRequest: async (modules, preparation) => {
    if (!preparation?.requestState) return modules;
    const handlers = createExecHandlers(
      context,
      readExecSettings(context.config),
      preparation,
    );
    return modules.map((module) => ({
      ...module,
      implementation: handlers[module.definition.name as keyof typeof handlers],
    }));
  },
  adapters: {
    exec: createExecAdapter(),
  },
}));
