import { defineRuntimePlugin } from "../../../src/plugin-sdk/index.js";

import { createExecHandlers } from "./handlers.js";
import { readExecSettings } from "./settings.js";
import { createExecAdapter } from "./validation.js";

export default defineRuntimePlugin((context) => ({
  handlers: createExecHandlers(context, readExecSettings(context.config)),
  adapters: {
    exec: createExecAdapter(),
  },
}));
