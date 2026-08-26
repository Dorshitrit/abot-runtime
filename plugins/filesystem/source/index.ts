import {
  defineRuntimePlugin,
  failureFromError,
  failureResult,
  type ToolImplementation,
} from "../../../src/plugin-sdk/index.js";

import { editFileAdapter, writeFileAdapter } from "./adapters.js";
import { createDevViewHandler } from "./dev-view.js";
import { createEditFileHandler } from "./edit-file.js";
import { FilesystemToolError } from "./errors.js";
import { getProcessFilesystemMutationCoordinator } from "./mutation-coordinator.js";
import { createFilesystemPathService } from "./path-service.js";
import { createReadFileHandler } from "./read-file.js";
import { createWriteFileHandler } from "./write-file.js";

function settle(
  handler: ToolImplementation,
  operation: string,
): ToolImplementation {
  return async (params, context) => {
    try {
      return await handler(params, context);
    } catch (error: unknown) {
      if (error instanceof FilesystemToolError) {
        return failureResult({
          errorCode: error.code,
          message: error.message,
          data: error.data,
        });
      }
      return failureFromError(error, {
        fallbackCode: `filesystem_${operation}_failed`,
        fallbackMessage: `Filesystem ${operation} failed.`,
        operation,
      });
    }
  };
}

export default defineRuntimePlugin((context) => {
  const paths = createFilesystemPathService(context.runtimePathResolver);
  const mutations = getProcessFilesystemMutationCoordinator();
  return Object.freeze({
    handlers: Object.freeze({
      dev_view: settle(createDevViewHandler(paths), "dev_view"),
      edit_file: settle(createEditFileHandler(paths, mutations), "edit_file"),
      read_file: settle(createReadFileHandler(paths), "read_file"),
      write_file: settle(
        createWriteFileHandler(paths, mutations),
        "write_file",
      ),
    }),
    adapters: Object.freeze({
      edit_file: editFileAdapter,
      write_file: writeFileAdapter,
    }),
  });
});
