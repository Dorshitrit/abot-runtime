import {
  defineRuntimePlugin,
  failureResult,
  readBoundedInteger,
  readOptionalString,
  resolvePluginPath,
} from "../../../src/plugin-sdk/index.js";

import {
  projectInspectionFailure,
  throwIfProjectInspectionCancelled,
} from "./inspection-failure.js";
import { readProjectManifests } from "./manifest-summary.js";
import { collectProjectTree } from "./tree.js";
import { readProjectTargetInfo } from "./project-target.js";
import { boundProjectInspectionFailure, buildProjectInspectionPage } from "./result-page.js";

const DEFAULT_DEPTH = 0;
const DEFAULT_MAX_ENTRIES = 40;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 250;

export default defineRuntimePlugin((context) => {
  const defaultDepth = readBoundedInteger(context.config?.defaultDepth, {
    defaultValue: DEFAULT_DEPTH,
    minimum: 0,
    maximum: MAX_DEPTH,
    name: "defaultDepth",
  });
  const defaultMaxEntries = readBoundedInteger(context.config?.maxEntries, {
    defaultValue: DEFAULT_MAX_ENTRIES,
    minimum: 1,
    maximum: MAX_ENTRIES,
    name: "maxEntries",
  });

  return {
    handlers: {
      async inspect_project(params, executionContext = undefined) {
        const pathContext = {
          ...context,
          runtimePathResolver:
            executionContext?.runtimePathResolver ??
            context.runtimePathResolver,
        };
        const signal = executionContext?.abortSignal;
        try {
          throwIfProjectInspectionCancelled(signal);
          const requestedPath = readOptionalString(params.path) ?? ".";
          const target = resolvePluginPath(pathContext, requestedPath, {
            defaultPath: ".",
            allowedLocations: ["agent_work", "workspace"],
          });
          const info = await readProjectTargetInfo(target.absolutePath, signal);
          if (!info.isDirectory()) {
            return failureResult({
              errorCode: "project_target_not_directory",
              message: "The requested project target is not a directory.",
            });
          }
          const depth = readBoundedInteger(params.depth, {
            defaultValue: defaultDepth,
            minimum: 0,
            maximum: MAX_DEPTH,
            name: "depth",
          });
          const maxEntries = readBoundedInteger(params.maxEntries, {
            defaultValue: defaultMaxEntries,
            minimum: 1,
            maximum: MAX_ENTRIES,
            name: "maxEntries",
          });
          const cursor = readOptionalString(params.cursor, {
            name: "cursor", trim: false, minLength: 1, maxLength: 1024,
          });
          const [listing, manifests] = await Promise.all([
            collectProjectTree(pathContext, target, depth, signal),
            readProjectManifests(pathContext, target, signal),
          ]);
          throwIfProjectInspectionCancelled(signal);
          return buildProjectInspectionPage({
            target, depth, maxEntries, cursor, listing, manifests,
          });
        } catch (error) {
          return boundProjectInspectionFailure(projectInspectionFailure(error, signal));
        }
      },
    },
  };
});
