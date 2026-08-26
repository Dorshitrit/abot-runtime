// GENERATED FILE - DO NOT EDIT.
// Source: plugins/capability-brief/source/index.ts
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

// plugins/capability-brief/source/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);

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
function boundCollection(values, options) {
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 0) {
    throw new RangeError("maxItems must be a non-negative safe integer");
  }
  const items = Object.freeze(values.slice(0, options.maxItems));
  return Object.freeze({
    items,
    metadata: Object.freeze({
      truncated: values.length > items.length,
      totalItems: values.length,
      returnedItems: items.length,
      omittedItems: values.length - items.length
    })
  });
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

// plugins/capability-brief/source/index.ts
var TOOL_COUNT_MAX = 64;
var OUTPUT_CHARACTER_MAX = 16e3;
var index_default = defineRuntimePlugin(() => ({
  handlers: {
    async capability_brief(_params, executionContext) {
      const availableTools = executionContext?.sharedState?.availableTools;
      if (availableTools === void 0) {
        return failureResult({
          errorCode: "available_tool_catalog_unavailable",
          message: "The request-effective tool catalog is unavailable."
        });
      }
      const orderedTools = [...availableTools].sort(compareAvailableTools);
      const boundedTools = boundCollection(orderedTools, {
        maxItems: TOOL_COUNT_MAX
      });
      const rawOutput = [
        `Available tool operations: ${availableTools.length}`,
        ...boundedTools.items.map(formatAvailableTool),
        ...boundedTools.metadata.truncated ? [
          `[${boundedTools.metadata.omittedItems} additional tool operations omitted]`
        ] : []
      ].join("\n");
      const boundedOutput = boundText(rawOutput, {
        maxChars: OUTPUT_CHARACTER_MAX,
        marker: "\n[available tool brief truncated]"
      });
      return successResult({
        output: boundedOutput.text,
        producedNewInformation: true,
        data: {
          source: "request_effective_tool_registry",
          toolOperationCount: availableTools.length,
          collection: boundedTools.metadata,
          output: boundedOutput.metadata,
          observationMeta: {
            kind: "stable_fact",
            carryPolicy: "never"
          }
        }
      });
    }
  }
}));
function formatAvailableTool(tool) {
  return [
    `- ${tool.operationId}`,
    `(tool=${tool.toolName}; effect=${tool.effect}; groups=${tool.catalogGroups.join(",")})`,
    tool.summary
  ].join(" ");
}
function compareAvailableTools(left, right) {
  const byOperation = compareAscii(left.operationId, right.operationId);
  return byOperation !== 0 ? byOperation : compareAscii(left.toolName, right.toolName);
}
function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
