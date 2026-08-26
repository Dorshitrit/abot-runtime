import { stat } from "node:fs/promises";

import {
  boundText,
  defineRuntimePlugin,
  failureFromError,
  failureResult,
  readBoundedInteger,
  readOptionalString,
  resolvePluginPath,
  successResult,
} from "../../../src/plugin-sdk/index.js";

import { readProjectManifests } from "./manifest-summary.js";
import { collectProjectTree } from "./tree.js";

const DEFAULT_DEPTH = 3;
const DEFAULT_MAX_ENTRIES = 200;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 250;
const OUTPUT_MAX_CHARS = 8_000;

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
      async inspect_project(params) {
        try {
          const requestedPath = readOptionalString(params.path) ?? ".";
          const target = resolvePluginPath(context, requestedPath, {
            defaultPath: ".",
            allowedLocations: ["agent_work", "workspace"],
          });
          const info = await stat(target.absolutePath);
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
          const [tree, manifests] = await Promise.all([
            collectProjectTree(context, target, depth, maxEntries),
            readProjectManifests(context, target),
          ]);
          const packageManifest = manifests.find(
            ({ file }) => file === "package.json",
          );
          const rawOutput = [
            `Project target: ${target.logicalPath}`,
            `Directories (${tree.directories.length}${tree.truncated ? ", bounded sample" : ""}): ${tree.directories.join(", ") || "none"}`,
            `Files (${tree.files.length}${tree.truncated ? ", bounded sample" : ""}): ${tree.files.join(", ") || "none"}`,
            `Manifests: ${manifests.map(({ file }) => file).join(", ") || "none"}`,
            packageManifest?.scripts?.length
              ? `Package scripts: ${packageManifest.scripts.join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");
          const output = boundText(rawOutput, {
            maxChars: OUTPUT_MAX_CHARS,
            marker: "\n[project orientation output truncated]",
          });
          return successResult({
            output: output.text,
            producedNewInformation: true,
            data: {
              location: target.location,
              target: target.logicalPath,
              depth,
              maxEntries,
              tree,
              manifests,
              truncation: {
                output: output.metadata,
                tree: tree.truncated,
                pathCount: tree.truncatedPathCount,
              },
              observationMeta: {
                kind: "volatile_external",
                carryPolicy: "never",
              },
            },
          });
        } catch (error) {
          return failureFromError(error, {
            fallbackCode: "project_orientation_failed",
            fallbackMessage: "Project orientation failed.",
            operation: "inspect_project",
          });
        }
      },
    },
  };
});
