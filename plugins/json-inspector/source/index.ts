import { TextDecoder } from "node:util";

import {
  boundText,
  defineRuntimePlugin,
  failureFromError,
  failureResult,
  readBoundedRegularFile,
  readBoundedInteger,
  readRequiredString,
  resolvePluginPath,
  successResult,
} from "../../../src/plugin-sdk/index.js";

import { parseJsonErrorPosition, summarizeJsonShape } from "./shape.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 6;
const OUTPUT_MAX_CHARS = 8_000;

export default defineRuntimePlugin((context) => {
  const defaultDepth = readBoundedInteger(context.config?.defaultDepth, {
    defaultValue: 3,
    minimum: 0,
    maximum: MAX_DEPTH,
    name: "defaultDepth",
  });

  return {
    handlers: {
      async inspect_json(params) {
        try {
          const requestedPath = readRequiredString(params.path, "path");
          const target = resolvePluginPath(context, requestedPath, {
            requirePath: true,
            allowedLocations: ["agent_work", "workspace"],
          });
          const file = await readBoundedRegularFile(target.absolutePath, {
            maxBytes: MAX_FILE_BYTES,
            rootPath: target.rootPath,
          });
          if (!file.ok && file.reason === "not_regular_file") {
            return failureResult({
              errorCode: "json_target_not_file",
              message: "The requested JSON target is not a regular file.",
            });
          }
          if (!file.ok && file.reason === "too_large") {
            return failureResult({
              errorCode: "json_file_too_large",
              message: `The requested file exceeds the ${MAX_FILE_BYTES}-byte JSON inspection limit.`,
            });
          }
          if (!file.ok) {
            return failureResult({
              errorCode: "json_file_changed",
              message: "The requested JSON file changed while it was read.",
            });
          }
          let source: string;
          try {
            source = new TextDecoder("utf-8", { fatal: true }).decode(
              file.bytes,
            );
          } catch {
            return failureResult({
              errorCode: "json_invalid_encoding",
              message: "The requested JSON file must contain valid UTF-8 text.",
            });
          }
          const maxDepth = readBoundedInteger(params.maxDepth, {
            defaultValue: defaultDepth,
            minimum: 0,
            maximum: MAX_DEPTH,
            name: "maxDepth",
          });
          let parsed: unknown;
          try {
            parsed = JSON.parse(source) as unknown;
          } catch (error) {
            const position = parseJsonErrorPosition(error, source);
            return successResult({
              output: [
                `JSON syntax is invalid: ${target.logicalPath}`,
                position
                  ? `Location: line ${position.line}, column ${position.column}`
                  : "Location: unavailable",
              ].join("\n"),
              producedNewInformation: true,
              data: {
                location: target.location,
                path: target.logicalPath,
                valid: false,
                syntaxValid: false,
                ...(position ? { position } : {}),
                observationMeta: {
                  kind: "volatile_external",
                  carryPolicy: "never",
                },
              },
            });
          }
          const summary = summarizeJsonShape(parsed, maxDepth);
          const rawOutput = [
            `Valid JSON: ${target.logicalPath}`,
            `Bytes: ${Buffer.byteLength(source, "utf8")}`,
            `Top-level type: ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}`,
            `Structure (depth ${maxDepth}, ${summary.metadata.visitedNodes}/${summary.metadata.maxNodes} nodes):`,
            JSON.stringify(summary.shape, null, 2),
          ].join("\n");
          const bounded = boundText(rawOutput, {
            maxChars: OUTPUT_MAX_CHARS,
            marker: "\n[JSON structure output truncated]",
          });
          return successResult({
            output: bounded.text,
            producedNewInformation: true,
            data: {
              location: target.location,
              path: target.logicalPath,
              valid: true,
              syntaxValid: true,
              maxDepth,
              structure: summary.shape,
              truncation: {
                ...summary.metadata,
                output: bounded.metadata,
              },
              observationMeta: {
                kind: "volatile_external",
                carryPolicy: "never",
              },
            },
          });
        } catch (error) {
          return failureFromError(error, {
            fallbackCode: "json_inspection_failed",
            fallbackMessage: "JSON inspection failed.",
            operation: "inspect_json",
          });
        }
      },
    },
  };
});
