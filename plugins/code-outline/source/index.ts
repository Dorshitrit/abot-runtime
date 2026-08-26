import { extname } from "node:path";

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

import { buildCodeOutline } from "./parser.js";

const MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_SYMBOLS = 160;
const MAX_SYMBOLS = 160;
const OUTPUT_MAX_CHARS = 6_000;

export default defineRuntimePlugin((context) => {
  const defaultMaxSymbols = readBoundedInteger(
    context.config?.defaultMaxSymbols,
    {
      defaultValue: DEFAULT_MAX_SYMBOLS,
      minimum: 1,
      maximum: MAX_SYMBOLS,
      name: "defaultMaxSymbols",
    },
  );

  return {
    handlers: {
      async inspect_code_outline(params) {
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
              errorCode: "code_outline_target_not_file",
              message:
                "The requested code-outline target is not a regular file.",
            });
          }
          if (!file.ok && file.reason === "too_large") {
            return failureResult({
              errorCode: "code_outline_file_too_large",
              message: `The requested file exceeds the ${MAX_FILE_BYTES}-byte outline limit.`,
            });
          }
          if (!file.ok) {
            return failureResult({
              errorCode: "code_outline_file_changed",
              message: "The requested file changed while it was being read.",
            });
          }
          const source = file.bytes.toString("utf8");
          const maxSymbols = readBoundedInteger(params.maxSymbols, {
            defaultValue: defaultMaxSymbols,
            minimum: 1,
            maximum: MAX_SYMBOLS,
            name: "maxSymbols",
          });
          const outline = buildCodeOutline(
            source,
            extname(target.absolutePath).toLowerCase(),
            maxSymbols,
          );
          const lineCount = source.length === 0 ? 0 : source.split("\n").length;
          const rendered = [
            `Code outline: ${target.logicalPath}`,
            `Lines: ${lineCount}`,
            `Symbols (${outline.metadata.returnedSymbols}/${outline.metadata.totalSymbols}${outline.metadata.symbolsTruncated ? ", truncated" : ""}):`,
            ...outline.symbols.map(
              (symbol) =>
                `- ${symbol.kind} ${symbol.name} (line ${symbol.line})`,
            ),
            `Imports/references (${outline.metadata.returnedImports}/${outline.metadata.totalImports}${outline.metadata.importsTruncated ? ", truncated" : ""}): ${outline.imports.join(", ") || "none"}`,
          ].join("\n");
          const boundedOutput = boundText(rendered, {
            maxChars: OUTPUT_MAX_CHARS,
            marker: "\n[outline output truncated]",
          });
          return successResult({
            output: boundedOutput.text,
            producedNewInformation: true,
            data: {
              location: target.location,
              path: target.logicalPath,
              lineCount,
              symbols: outline.symbols,
              imports: outline.imports,
              limits: {
                maxFileBytes: MAX_FILE_BYTES,
                outputMaxChars: OUTPUT_MAX_CHARS,
              },
              truncation: {
                ...outline.metadata,
                output: boundedOutput.metadata,
              },
              observationMeta: {
                kind: "volatile_external",
                carryPolicy: "never",
              },
            },
          });
        } catch (error) {
          return failureFromError(error, {
            fallbackCode: "code_outline_failed",
            fallbackMessage: "Code outline inspection failed.",
            operation: "inspect_code_outline",
          });
        }
      },
    },
  };
});
