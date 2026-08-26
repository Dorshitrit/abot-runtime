import { defineRuntimePlugin } from "../../../src/plugin-sdk/index.js";

import { createDocumentReaderHandler } from "./handler.js";

export default defineRuntimePlugin((context) =>
  Object.freeze({
    handlers: Object.freeze({
      document_reader: createDocumentReaderHandler(context),
    }),
  }),
);
