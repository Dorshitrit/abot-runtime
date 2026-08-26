// GENERATED FILE - DO NOT EDIT.
// Source: plugins/json-inspector/source/index.ts
// Run "npm run build:plugins" after editing plugin source.
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugins/json-inspector/source/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var import_node_util = require("node:util");

// src/plugin-sdk/bounds.ts
function boundText(value, options) {
  if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 0) {
    throw new RangeError("maxChars must be a non-negative safe integer");
  }
  const marker = options.marker ?? "\n[truncated]";
  const truncated = value.length > options.maxChars;
  const boundedMarker = marker.slice(0, options.maxChars);
  const sourceChars = truncated ? Math.max(options.maxChars - boundedMarker.length, 0) : value.length;
  const text = truncated ? value.slice(0, sourceChars) + boundedMarker : value;
  return Object.freeze({
    text,
    metadata: Object.freeze({
      truncated,
      originalChars: value.length,
      returnedChars: text.length,
      omittedChars: Math.max(value.length - sourceChars, 0)
    })
  });
}
function sanitizeJsonText(value) {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const preservedWhitespace = codePoint === 9 || codePoint === 10 || codePoint === 13;
    const unsafeControl = codePoint < 32 && !preservedWhitespace || codePoint >= 127 && codePoint <= 159;
    const unpairedSurrogate = codePoint >= 55296 && codePoint <= 57343;
    return unsafeControl || unpairedSurrogate ? "�" : character;
  }).join("");
}

// src/plugin-sdk/files.ts
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error("The file read was cancelled.");
  error.name = "AbortError";
  throw error;
}
async function readExact(handle, buffer, signal) {
  let offset = 0;
  while (offset < buffer.length) {
    throwIfAborted(signal);
    const result = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset
    );
    if (result.bytesRead === 0) return false;
    offset += result.bytesRead;
  }
  return true;
}
async function readBoundedRegularFile(absolutePath, options) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  throwIfAborted(options.signal);
  if (typeof import_node_fs.constants.O_NOFOLLOW !== "number") {
    return Object.freeze({ ok: false, reason: "safe_open_unsupported" });
  }
  let handle;
  try {
    handle = await (0, import_promises.open)(
      absolutePath,
      import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_NOFOLLOW
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      return Object.freeze({ ok: false, reason: "not_regular_file" });
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      (0, import_promises.realpath)(options.rootPath),
      (0, import_promises.realpath)(absolutePath)
    ]);
    const rootRelative = (0, import_node_path.relative)(canonicalRoot, canonicalTarget);
    if (rootRelative === ".." || rootRelative.startsWith(`..${import_node_path.sep}`) || rootRelative.startsWith(import_node_path.sep)) {
      return Object.freeze({ ok: false, reason: "outside_root" });
    }
    const pathIdentity = await (0, import_promises.stat)(canonicalTarget, { bigint: true });
    if (pathIdentity.dev !== before.dev || pathIdentity.ino !== before.ino || !pathIdentity.isFile()) {
      return Object.freeze({ ok: false, reason: "changed_during_read" });
    }
    const byteCount = Number(before.size);
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) {
      return Object.freeze({
        ok: false,
        reason: "too_large",
        byteCount
      });
    }
    if (byteCount > options.maxBytes) {
      return Object.freeze({
        ok: false,
        reason: "too_large",
        byteCount
      });
    }
    const bytes = Buffer.alloc(byteCount);
    if (!await readExact(handle, bytes, options.signal)) {
      return Object.freeze({
        ok: false,
        reason: "changed_during_read",
        byteCount
      });
    }
    throwIfAborted(options.signal);
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || Number(after.size) !== byteCount || after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      return Object.freeze({
        ok: false,
        reason: "changed_during_read",
        byteCount: Number(after.size)
      });
    }
    return Object.freeze({ ok: true, bytes, byteCount });
  } finally {
    await handle?.close().catch(() => void 0);
  }
}

// src/plugin-sdk/parameters.ts
var PluginParameterError = class extends TypeError {
  code;
  parameter;
  constructor(params) {
    super(params.message ?? `${params.parameter}: ${params.code}`);
    this.name = "PluginParameterError";
    this.code = params.code;
    this.parameter = params.parameter;
  }
};
function isPluginParameterError(error) {
  return error instanceof PluginParameterError;
}
function stringOptions(input) {
  return typeof input === "string" ? { name: input } : input;
}
function parameterName(options) {
  return options.name ?? options.parameter ?? "value";
}
function parseString(value, options) {
  if (value === void 0 || value === null) return void 0;
  const parameter = parameterName(options);
  if (typeof value !== "string") {
    throw new PluginParameterError({
      code: "plugin_parameter_invalid",
      parameter
    });
  }
  const parsed = options.trim === false ? value : value.trim();
  if (options.minLength !== void 0 && parsed.length < options.minLength || options.maxLength !== void 0 && parsed.length > options.maxLength) {
    throw new PluginParameterError({
      code: "plugin_parameter_invalid",
      parameter
    });
  }
  return parsed;
}
function readRequiredString(value, input = {}) {
  const options = stringOptions(input);
  const parameter = parameterName(options);
  const parsed = parseString(value, {
    ...options,
    minLength: Math.max(options.minLength ?? 1, 1)
  });
  if (parsed === void 0) {
    throw new PluginParameterError({
      code: "plugin_parameter_required",
      parameter
    });
  }
  return parsed;
}
function readBoundedInteger(value, options) {
  const parameter = parameterName(options);
  const candidate = value === void 0 ? options.defaultValue : value;
  if (!Number.isSafeInteger(candidate) || candidate < options.minimum || candidate > options.maximum) {
    throw new PluginParameterError({
      code: candidate === void 0 ? "plugin_parameter_required" : "plugin_parameter_invalid",
      parameter
    });
  }
  return candidate;
}

// src/plugin-sdk/paths.ts
function resolvePluginPath(context, rawPath, options = {}) {
  return context.runtimePathResolver.resolve(rawPath, options);
}
function runtimeToolPathErrorCode(error) {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string" || !error.code.startsWith("runtime_tool_path_")) {
    return void 0;
  }
  return error.code;
}

// src/plugin-sdk/plugin.ts
function defineRuntimePlugin(definition) {
  return definition;
}

// src/plugin-sdk/results.ts
var PLUGIN_RESULT_SERIALIZED_MAX_BYTES = 128 * 1024;
function resultBoundsFailure(code, message) {
  return {
    ok: false,
    output: message,
    producedNewInformation: false,
    error: message,
    errorCode: code
  };
}
function enforcePluginResultByteBudget(result) {
  let serialized;
  try {
    const candidate = JSON.stringify(result);
    if (candidate === void 0) {
      return resultBoundsFailure(
        "plugin_result_not_json_safe",
        "The plugin produced a result that is not JSON-safe."
      );
    }
    serialized = candidate;
  } catch {
    return resultBoundsFailure(
      "plugin_result_not_json_safe",
      "The plugin produced a result that is not JSON-safe."
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > PLUGIN_RESULT_SERIALIZED_MAX_BYTES) {
    return resultBoundsFailure(
      "plugin_result_too_large",
      `The plugin result exceeds the ${PLUGIN_RESULT_SERIALIZED_MAX_BYTES}-byte safety limit.`
    );
  }
  return result;
}
function successResult(input) {
  return enforcePluginResultByteBudget({
    ok: true,
    output: input.output,
    producedNewInformation: input.producedNewInformation ?? true,
    ...input.progress !== void 0 ? { progress: input.progress } : {},
    ...input.actions !== void 0 ? { actions: input.actions } : {},
    ...input.exitCode !== void 0 ? { exitCode: input.exitCode } : {},
    ...input.stdout !== void 0 ? { stdout: input.stdout } : {},
    ...input.stderr !== void 0 ? { stderr: input.stderr } : {},
    ...input.data !== void 0 ? { data: input.data } : {}
  });
}
function failureResult(input) {
  return enforcePluginResultByteBudget({
    ok: false,
    output: input.output ?? input.message,
    producedNewInformation: false,
    ...input.progress !== void 0 ? { progress: input.progress } : {},
    ...input.actions !== void 0 ? { actions: input.actions } : {},
    ...input.exitCode !== void 0 ? { exitCode: input.exitCode } : {},
    ...input.stdout !== void 0 ? { stdout: input.stdout } : {},
    ...input.stderr !== void 0 ? { stderr: input.stderr } : {},
    ...input.data !== void 0 ? { data: input.data } : {},
    error: input.message,
    errorCode: input.errorCode
  });
}
function failureFromError(error, options) {
  const pathCode = runtimeToolPathErrorCode(error);
  const parameterCode = isPluginParameterError(error) ? error.code : void 0;
  const errorCode = pathCode ?? parameterCode ?? options.fallbackCode;
  const message = pathCode ?? parameterCode ?? options.fallbackMessage;
  return failureResult({
    errorCode,
    message,
    output: options.operation ? `${options.operation} failed: ${message}` : message
  });
}

// plugins/json-inspector/source/shape.ts
var OBJECT_KEY_LIMIT = 40;
var OBJECT_KEY_MAX_CHARS = 64;
var ARRAY_SAMPLE_SIZE = 3;
var MAX_NODES = 200;
function boundedKey(value) {
  const safeValue = sanitizeJsonText(value);
  if (safeValue.length <= OBJECT_KEY_MAX_CHARS) return safeValue;
  const marker = "...[truncated]";
  return `${safeValue.slice(0, OBJECT_KEY_MAX_CHARS - marker.length)}${marker}`;
}
function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
function summarizeJsonShape(value, maxDepth) {
  let visitedNodes = 0;
  let truncatedNodes = 0;
  let truncatedKeys = 0;
  const visit = (current, depth) => {
    if (visitedNodes >= MAX_NODES) {
      truncatedNodes += 1;
      return `[${valueType(current)} omitted: node budget reached]`;
    }
    visitedNodes += 1;
    if (depth >= maxDepth) {
      if (current !== null && typeof current === "object") truncatedNodes += 1;
      return `[${valueType(current)} at depth limit]`;
    }
    if (Array.isArray(current)) {
      const sampled = current.slice(0, ARRAY_SAMPLE_SIZE);
      if (sampled.length < current.length) truncatedNodes += 1;
      return Object.freeze({
        type: "array",
        length: current.length,
        sampledItems: Object.freeze(
          sampled.map((item) => visit(item, depth + 1))
        ),
        returnedItems: sampled.length,
        truncated: sampled.length < current.length
      });
    }
    if (current && typeof current === "object") {
      const record = current;
      const names = Object.keys(record).sort(
        (left, right) => left.localeCompare(right)
      );
      const returnedNames = names.slice(0, OBJECT_KEY_LIMIT);
      if (returnedNames.length < names.length) truncatedNodes += 1;
      return Object.freeze({
        type: "object",
        totalKeys: names.length,
        returnedKeys: returnedNames.length,
        truncated: returnedNames.length < names.length,
        keys: Object.freeze(
          returnedNames.map((key) => {
            if (key.length > OBJECT_KEY_MAX_CHARS) truncatedKeys += 1;
            return Object.freeze({
              key: boundedKey(key),
              value: visit(record[key], depth + 1)
            });
          })
        )
      });
    }
    return Object.freeze({
      type: "primitive",
      valueType: valueType(current)
    });
  };
  return Object.freeze({
    shape: visit(value, 0),
    metadata: Object.freeze({
      maxDepth,
      maxNodes: MAX_NODES,
      visitedNodes,
      truncatedNodes,
      truncatedKeys,
      arraySampleSize: ARRAY_SAMPLE_SIZE,
      objectKeyLimit: OBJECT_KEY_LIMIT,
      objectKeyMaxChars: OBJECT_KEY_MAX_CHARS
    })
  });
}
function parseJsonErrorPosition(error, source) {
  const message = error instanceof Error ? error.message : "";
  const match = /position\s+(\d+)/iu.exec(message);
  if (!match?.[1]) return void 0;
  const position = Number(match[1]);
  if (!Number.isSafeInteger(position) || position < 0) return void 0;
  const prefix = source.slice(0, position);
  const lineStart = prefix.lastIndexOf("\n");
  return Object.freeze({
    position,
    line: prefix.split("\n").length,
    column: position - lineStart
  });
}

// plugins/json-inspector/source/index.ts
var MAX_FILE_BYTES = 2 * 1024 * 1024;
var MAX_DEPTH = 6;
var OUTPUT_MAX_CHARS = 8e3;
var index_default = defineRuntimePlugin((context) => {
  const defaultDepth = readBoundedInteger(context.config?.defaultDepth, {
    defaultValue: 3,
    minimum: 0,
    maximum: MAX_DEPTH,
    name: "defaultDepth"
  });
  return {
    handlers: {
      async inspect_json(params) {
        try {
          const requestedPath = readRequiredString(params.path, "path");
          const target = resolvePluginPath(context, requestedPath, {
            requirePath: true,
            allowedLocations: ["agent_work", "workspace"]
          });
          const file = await readBoundedRegularFile(target.absolutePath, {
            maxBytes: MAX_FILE_BYTES,
            rootPath: target.rootPath
          });
          if (!file.ok && file.reason === "not_regular_file") {
            return failureResult({
              errorCode: "json_target_not_file",
              message: "The requested JSON target is not a regular file."
            });
          }
          if (!file.ok && file.reason === "too_large") {
            return failureResult({
              errorCode: "json_file_too_large",
              message: `The requested file exceeds the ${MAX_FILE_BYTES}-byte JSON inspection limit.`
            });
          }
          if (!file.ok) {
            return failureResult({
              errorCode: "json_file_changed",
              message: "The requested JSON file changed while it was read."
            });
          }
          let source;
          try {
            source = new import_node_util.TextDecoder("utf-8", { fatal: true }).decode(
              file.bytes
            );
          } catch {
            return failureResult({
              errorCode: "json_invalid_encoding",
              message: "The requested JSON file must contain valid UTF-8 text."
            });
          }
          const maxDepth = readBoundedInteger(params.maxDepth, {
            defaultValue: defaultDepth,
            minimum: 0,
            maximum: MAX_DEPTH,
            name: "maxDepth"
          });
          let parsed;
          try {
            parsed = JSON.parse(source);
          } catch (error) {
            const position = parseJsonErrorPosition(error, source);
            return successResult({
              output: [
                `JSON syntax is invalid: ${target.logicalPath}`,
                position ? `Location: line ${position.line}, column ${position.column}` : "Location: unavailable"
              ].join("\n"),
              producedNewInformation: true,
              data: {
                location: target.location,
                path: target.logicalPath,
                valid: false,
                syntaxValid: false,
                ...position ? { position } : {},
                observationMeta: {
                  kind: "volatile_external",
                  carryPolicy: "never"
                }
              }
            });
          }
          const summary = summarizeJsonShape(parsed, maxDepth);
          const rawOutput = [
            `Valid JSON: ${target.logicalPath}`,
            `Bytes: ${Buffer.byteLength(source, "utf8")}`,
            `Top-level type: ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}`,
            `Structure (depth ${maxDepth}, ${summary.metadata.visitedNodes}/${summary.metadata.maxNodes} nodes):`,
            JSON.stringify(summary.shape, null, 2)
          ].join("\n");
          const bounded = boundText(rawOutput, {
            maxChars: OUTPUT_MAX_CHARS,
            marker: "\n[JSON structure output truncated]"
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
                output: bounded.metadata
              },
              observationMeta: {
                kind: "volatile_external",
                carryPolicy: "never"
              }
            }
          });
        } catch (error) {
          return failureFromError(error, {
            fallbackCode: "json_inspection_failed",
            fallbackMessage: "JSON inspection failed.",
            operation: "inspect_json"
          });
        }
      }
    }
  };
});
