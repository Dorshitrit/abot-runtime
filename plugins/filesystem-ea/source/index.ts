import { defineRuntimePlugin, failureResult } from "../../../src/plugin-sdk/index.js";
import { prepareEaRequest } from "./prepare-request.js";

export default defineRuntimePlugin((context) => {
  const enabled = context.config?.enabled !== false;
  const unavailable = async () => failureResult({ errorCode: "ea_request_preparation_required",
    message: "This plugin requires an enabled Execution Agent request." });
  return {
    handlers: { read_text: unavailable, create_text: unavailable, edit_text: unavailable },
    prepareRequest: prepareEaRequest(enabled),
    discoverCapabilities: async (selected) => enabled ? selected.map(({ definition }) => definition.name) : [],
  };
});
