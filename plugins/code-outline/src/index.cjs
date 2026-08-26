// GENERATED FILE - DO NOT EDIT.
// Source: plugins/code-outline/source/index.ts
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

// plugins/code-outline/source/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var import_node_path2 = require("node:path");

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

// plugins/code-outline/source/parser.ts
var import_parser = require("@babel/parser");
var IMPORT_LIMIT = 40;
var SYMBOL_NAME_MAX_CHARS = 96;
var IMPORT_VALUE_MAX_CHARS = 128;
function boundLabel(value, maxChars) {
  const safeValue = sanitizeJsonText(value);
  if (safeValue.length <= maxChars) return safeValue;
  const marker = "...[truncated]";
  return `${safeValue.slice(0, maxChars - marker.length)}${marker}`;
}
function nodeLine(node) {
  return node.loc?.start?.line ?? 1;
}
function identifierName(value) {
  if (!value || typeof value !== "object") return void 0;
  const candidate = value;
  return candidate.type === "Identifier" && typeof candidate.name === "string" ? candidate.name : void 0;
}
function literalValue(value) {
  if (!value || typeof value !== "object") return void 0;
  const candidate = value;
  return typeof candidate.value === "string" ? candidate.value : void 0;
}
function parseJavaScriptOutline(source) {
  const ast = (0, import_parser.parse)(source, {
    sourceType: "unambiguous",
    errorRecovery: true,
    plugins: ["jsx", "typescript", "decorators-legacy"]
  });
  const symbols = [];
  const imports = [];
  const pending = [ast.program];
  const seen = /* @__PURE__ */ new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const node = current;
    if (node.type === "FunctionDeclaration") {
      const name = identifierName(node.id);
      if (name) symbols.push({ kind: "function", name, line: nodeLine(node) });
    } else if (node.type === "ClassDeclaration") {
      const name = identifierName(node.id);
      if (name) symbols.push({ kind: "class", name, line: nodeLine(node) });
    } else if (node.type === "VariableDeclarator") {
      const name = identifierName(node.id);
      if (name) {
        const initializer = node.init;
        const kind = initializer?.type === "ArrowFunctionExpression" || initializer?.type === "FunctionExpression" ? "function_value" : "binding";
        symbols.push({ kind, name, line: nodeLine(node) });
      }
    } else if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") {
      const value = literalValue(node.source);
      if (value) imports.push(value);
    } else if (node.type === "CallExpression") {
      const calleeName = identifierName(node.callee);
      const argumentsValue = Array.isArray(node.arguments) ? node.arguments : [];
      if (calleeName === "require") {
        const value = literalValue(argumentsValue[0]);
        if (value) imports.push(value);
      }
    }
    for (const value of Object.values(node)) {
      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) pending.push(...value);
      else pending.push(value);
    }
  }
  return { symbols, imports };
}
function lineAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}
function parsePatternOutline(source, extension) {
  const symbols = [];
  const imports = [];
  const add = (expression, kind) => {
    for (const match of source.matchAll(expression)) {
      const name = match[1];
      if (name)
        symbols.push({ kind, name, line: lineAt(source, match.index ?? 0) });
    }
  };
  if (extension === ".py") {
    add(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gmu, "function");
    add(/^\s*class\s+([A-Za-z_]\w*)/gmu, "class");
    for (const match of source.matchAll(/^\s*(?:from|import)\s+([^\s]+)/gmu)) {
      if (match[1]) imports.push(match[1]);
    }
  } else if (extension === ".css" || extension === ".scss") {
    add(/^([^@\n][^{\n]{1,180})\{/gmu, "selector");
  } else if (extension === ".html" || extension === ".htm") {
    add(
      /<(?:section|main|header|footer|form|nav|h1|h2|h3)\b[^>]*(?:id|class)=["']([^"']+)["']/gimu,
      "element"
    );
  } else {
    add(/^\s*(?:function|class|def)\s+([A-Za-z_$][\w$]*)/gmu, "declaration");
  }
  return { symbols, imports };
}
function buildCodeOutline(source, extension, maxSymbols) {
  const parsed = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(
    extension
  ) ? parseJavaScriptOutline(source) : parsePatternOutline(source, extension);
  const uniqueSymbols = [
    ...new Map(
      parsed.symbols.sort(
        (left, right) => left.line - right.line || left.name.localeCompare(right.name)
      ).map((symbol) => [
        `${symbol.kind}\0${symbol.name}\0${symbol.line}`,
        symbol
      ])
    ).values()
  ];
  const uniqueImports = [...new Set(parsed.imports)].sort(
    (left, right) => left.localeCompare(right)
  );
  const selectedSymbols = uniqueSymbols.slice(0, maxSymbols);
  const selectedImports = uniqueImports.slice(0, IMPORT_LIMIT);
  const symbols = selectedSymbols.map(
    (symbol) => Object.freeze({
      ...symbol,
      name: boundLabel(symbol.name, SYMBOL_NAME_MAX_CHARS)
    })
  );
  const imports = selectedImports.map(
    (value) => boundLabel(value, IMPORT_VALUE_MAX_CHARS)
  );
  return Object.freeze({
    symbols: Object.freeze(symbols),
    imports: Object.freeze(imports),
    metadata: Object.freeze({
      symbolsTruncated: uniqueSymbols.length > symbols.length,
      totalSymbols: uniqueSymbols.length,
      returnedSymbols: symbols.length,
      importsTruncated: uniqueImports.length > imports.length,
      totalImports: uniqueImports.length,
      returnedImports: imports.length,
      truncatedSymbolNames: selectedSymbols.filter(
        ({ name }) => name.length > SYMBOL_NAME_MAX_CHARS
      ).length,
      truncatedImportValues: selectedImports.filter(
        (value) => value.length > IMPORT_VALUE_MAX_CHARS
      ).length,
      symbolNameMaxChars: SYMBOL_NAME_MAX_CHARS,
      importValueMaxChars: IMPORT_VALUE_MAX_CHARS
    })
  });
}

// plugins/code-outline/source/index.ts
var MAX_FILE_BYTES = 512 * 1024;
var DEFAULT_MAX_SYMBOLS = 160;
var MAX_SYMBOLS = 160;
var OUTPUT_MAX_CHARS = 6e3;
var index_default = defineRuntimePlugin((context) => {
  const defaultMaxSymbols = readBoundedInteger(
    context.config?.defaultMaxSymbols,
    {
      defaultValue: DEFAULT_MAX_SYMBOLS,
      minimum: 1,
      maximum: MAX_SYMBOLS,
      name: "defaultMaxSymbols"
    }
  );
  return {
    handlers: {
      async inspect_code_outline(params) {
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
              errorCode: "code_outline_target_not_file",
              message: "The requested code-outline target is not a regular file."
            });
          }
          if (!file.ok && file.reason === "too_large") {
            return failureResult({
              errorCode: "code_outline_file_too_large",
              message: `The requested file exceeds the ${MAX_FILE_BYTES}-byte outline limit.`
            });
          }
          if (!file.ok) {
            return failureResult({
              errorCode: "code_outline_file_changed",
              message: "The requested file changed while it was being read."
            });
          }
          const source = file.bytes.toString("utf8");
          const maxSymbols = readBoundedInteger(params.maxSymbols, {
            defaultValue: defaultMaxSymbols,
            minimum: 1,
            maximum: MAX_SYMBOLS,
            name: "maxSymbols"
          });
          const outline = buildCodeOutline(
            source,
            (0, import_node_path2.extname)(target.absolutePath).toLowerCase(),
            maxSymbols
          );
          const lineCount = source.length === 0 ? 0 : source.split("\n").length;
          const rendered = [
            `Code outline: ${target.logicalPath}`,
            `Lines: ${lineCount}`,
            `Symbols (${outline.metadata.returnedSymbols}/${outline.metadata.totalSymbols}${outline.metadata.symbolsTruncated ? ", truncated" : ""}):`,
            ...outline.symbols.map(
              (symbol) => `- ${symbol.kind} ${symbol.name} (line ${symbol.line})`
            ),
            `Imports/references (${outline.metadata.returnedImports}/${outline.metadata.totalImports}${outline.metadata.importsTruncated ? ", truncated" : ""}): ${outline.imports.join(", ") || "none"}`
          ].join("\n");
          const boundedOutput = boundText(rendered, {
            maxChars: OUTPUT_MAX_CHARS,
            marker: "\n[outline output truncated]"
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
                outputMaxChars: OUTPUT_MAX_CHARS
              },
              truncation: {
                ...outline.metadata,
                output: boundedOutput.metadata
              },
              observationMeta: {
                kind: "volatile_external",
                carryPolicy: "never"
              }
            }
          });
        } catch (error) {
          return failureFromError(error, {
            fallbackCode: "code_outline_failed",
            fallbackMessage: "Code outline inspection failed.",
            operation: "inspect_code_outline"
          });
        }
      }
    }
  };
});
