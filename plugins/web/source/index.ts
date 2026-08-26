import { defineRuntimePlugin } from "../../../src/plugin-sdk/index.js";

import { createWebPlugin } from "./plugin.js";

export default defineRuntimePlugin((context) => createWebPlugin(context));
