import { failureFromError, failureResult, type ToolImplementation, type ToolModuleRequestPreparation } from "../../../src/plugin-sdk/index.js";
import { FilesystemToolError } from "../../filesystem/source/errors.js";
import { createFilesystemPathService } from "../../filesystem/source/path-service.js";
import { getProcessFilesystemMutationCoordinator } from "../../filesystem/source/mutation-coordinator.js";
import { prepareFilesystemRequest } from "../../filesystem/source/windows/request-availability.js";
import { createRangeReferences } from "./range-references.js";
import { createReadTextHandler } from "./read-text.js";
import { createPayloadAdapter } from "./payload-source.js";
import { createMutationHandler } from "./mutate-text.js";
import type { ToolRequestPreparationContext } from "../../../src/capabilities/tool-request-resources.js";
import type { RuntimeToolPathResolver } from "../../../src/plugin-sdk/index.js";

export function prepareEaRequest(enabled: boolean): ToolModuleRequestPreparation {
  return async (modules, context) => {
    if (!canPrepareEaFileRequest(enabled, context)) return [];
    if (!modules.length) return [];
    const paths = createFilesystemPathService(context.runtimePathResolver);
    const references = createRangeReferences(context);
    const mutations = getProcessFilesystemMutationCoordinator();
    const handlers: Record<string, ToolImplementation> = {
      read_text: createReadTextHandler(paths, references),
      create_text: createMutationHandler(paths, references, mutations, "create_text"),
      edit_text: createMutationHandler(paths, references, mutations, "edit_text"),
    };
    const prepared = modules.map((module) => ({ ...module,
      implementation: settle(handlers[module.definition.name]!),
      ...(module.definition.name === "read_text" ? {} : { adapter:
        createPayloadAdapter(paths, references, module.definition.name === "create_text" ? "create" : "edit") }),
    }));
    return prepareFilesystemRequest(prepared, context);
  };
}

function canPrepareEaFileRequest(enabled: boolean, context?: ToolRequestPreparationContext):
  context is ToolRequestPreparationContext & { requestId: string; runtimePathResolver: RuntimeToolPathResolver } {
  if (!enabled) return false;
  if (context?.rootContractId !== "execution_agent") return false;
  if (!context.requestId) return false;
  return context.runtimePathResolver !== undefined;
}

function settle(handler: ToolImplementation): ToolImplementation {
  return async (params, context) => {
    try { return await handler(params, context); }
    catch (error) {
      if (error instanceof FilesystemToolError) return failureResult({ errorCode: error.code, message: error.message });
      return failureFromError(error, { fallbackCode: "ea_filesystem_failed", fallbackMessage: "The file operation failed." });
    }
  };
}
