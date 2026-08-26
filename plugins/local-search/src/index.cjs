// GENERATED FILE - DO NOT EDIT.
// Source: plugins/local-search/source/index.ts
// Run "npm run build:plugins" after editing plugin source.
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugins/local-search/source/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var import_node_path2 = require("node:path");

// src/plugin-sdk/bounds.ts
function sanitizeJsonText(value) {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    const preservedWhitespace = codePoint === 9 || codePoint === 10 || codePoint === 13;
    const unsafeControl = codePoint < 32 && !preservedWhitespace || codePoint >= 127 && codePoint <= 159;
    const unpairedSurrogate = codePoint >= 55296 && codePoint <= 57343;
    return unsafeControl || unpairedSurrogate ? "�" : character;
  }).join("");
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
function readOptionalString(value, input = {}) {
  return parseString(value, stringOptions(input));
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
function readBoolean(value, options = {}) {
  const parameter = parameterName(options);
  const candidate = value === void 0 ? options.defaultValue : value;
  if (typeof candidate !== "boolean") {
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

// plugins/local-search/source/errors.ts
var LocalSearchError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "LocalSearchError";
    this.code = code;
  }
};
function isLocalSearchError(error) {
  return error instanceof LocalSearchError;
}

// plugins/local-search/source/output.ts
var MAX_OUTPUT_CHARS = 32768;
function display(value) {
  return JSON.stringify(value).slice(1, -1);
}
function render(params) {
  const names = params.entries.filter(
    (entry) => entry.kind === "name"
  ).map(({ value }) => `- ${display(value)}`);
  const content = params.entries.filter(
    (entry) => entry.kind === "content"
  ).map(
    ({ value }) => `- ${display(value.path)}:${value.lineNumber}:${sanitizeJsonText(value.text)}`
  );
  return [
    'Search scope: selected logical path; use "." for the current Worker root.',
    `Query: ${sanitizeJsonText(params.query)}`,
    `Mode: ${params.mode}`,
    `Returned matches: ${params.entries.length}${params.truncated ? " (bounded)" : ""}`,
    ...names.length > 0 ? ["Filename matches:", ...names] : [],
    ...content.length > 0 ? ["Content matches:", ...content] : [],
    ...params.entries.length === 0 ? ["No matches found."] : [],
    ...params.truncated ? ["Additional matches were omitted."] : []
  ].join("\n");
}
function budgetSearchOutput(query, mode, candidates, sourceTruncated, fitsSerializedResult) {
  const build = (entries2) => {
    const truncated = sourceTruncated || entries2.length < candidates.length;
    return Object.freeze({
      output: render({ query, mode, entries: entries2, truncated }),
      entries: Object.freeze([...entries2]),
      metadata: Object.freeze({
        truncated,
        sourceTruncated,
        candidateItems: candidates.length,
        returnedItems: entries2.length,
        outputMaxChars: MAX_OUTPUT_CHARS
      })
    });
  };
  const entries = [];
  for (const candidate of candidates) {
    const tentative = [...entries, candidate];
    const budgeted = build(tentative);
    if (budgeted.output.length > MAX_OUTPUT_CHARS || !fitsSerializedResult(budgeted)) {
      break;
    }
    entries.push(candidate);
  }
  const result = build(entries);
  if (!fitsSerializedResult(result)) {
    throw new RangeError(
      "The local-search result envelope exceeds its budget."
    );
  }
  return result;
}

// plugins/local-search/source/paths.ts
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path = __toESM(require("node:path"), 1);
function fsCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : void 0;
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.isFile() === right.isFile() && left.isDirectory() === right.isDirectory();
}
function isWithinRoot(root, target) {
  const relative = import_node_path.default.relative(root, target);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${import_node_path.default.sep}`) && !import_node_path.default.isAbsolute(relative);
}
function authorityUnavailable() {
  return new LocalSearchError(
    "local_search_failed",
    "Local search could not establish a safe read authority for the selected logical root."
  );
}
async function openSearchAuthority(target) {
  if (process.platform !== "linux" || !Number.isInteger(import_node_fs.constants.O_NOFOLLOW) || !Number.isInteger(import_node_fs.constants.O_NONBLOCK)) {
    throw authorityUnavailable();
  }
  let handle;
  let targetOpened = false;
  try {
    handle = await (0, import_promises.open)(
      target.absolutePath,
      import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_NOFOLLOW | import_node_fs.constants.O_NONBLOCK
    );
    targetOpened = true;
    const observed = await handle.stat({ bigint: true });
    if (!observed.isFile() && !observed.isDirectory()) {
      throw new LocalSearchError(
        "local_search_target_invalid",
        "The selected search target must be a regular file or directory."
      );
    }
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      (0, import_promises.realpath)(target.rootPath),
      (0, import_promises.realpath)(target.absolutePath)
    ]);
    if (import_node_path.default.resolve(canonicalRoot) !== import_node_path.default.resolve(target.rootPath) || import_node_path.default.resolve(canonicalTarget) !== import_node_path.default.resolve(target.absolutePath) || !isWithinRoot(canonicalRoot, canonicalTarget)) {
      throw authorityUnavailable();
    }
    const [pathIdentity, descriptorIdentity] = await Promise.all([
      (0, import_promises.stat)(canonicalTarget, { bigint: true }),
      (0, import_promises.stat)(`/proc/self/fd/${handle.fd}`, { bigint: true })
    ]);
    if (!sameIdentity(observed, pathIdentity) || !sameIdentity(observed, descriptorIdentity)) {
      throw authorityUnavailable();
    }
    const authority = handle;
    const isFile = observed.isFile();
    let closed = false;
    handle = void 0;
    return Object.freeze({
      target,
      isFile,
      commandDirectory: isFile ? "/" : `/proc/self/fd/${authority.fd}`,
      commandTarget: isFile ? "-" : ".",
      ...isFile ? { stdinFd: authority.fd } : {},
      close: async () => {
        if (closed) return;
        closed = true;
        await authority.close();
      }
    });
  } catch (error) {
    await handle?.close().catch(() => void 0);
    if (error instanceof LocalSearchError) throw error;
    const code = fsCode(error);
    if (!targetOpened && (code === "ENOENT" || code === "ENOTDIR")) {
      throw new LocalSearchError(
        "local_search_root_not_found",
        "The selected logical search root does not exist."
      );
    }
    throw authorityUnavailable();
  }
}
async function resolveSearchRoot(context, rawPath) {
  const requested = typeof rawPath === "string" && rawPath.trim() ? rawPath : ".";
  const target = resolvePluginPath(context, requested, {
    requirePath: true,
    allowedLocations: ["agent_work", "workspace"]
  });
  return openSearchAuthority(target);
}
function normalizeRelativeResult(value) {
  const normalized = import_node_path.default.sep === "/" ? value : value.replaceAll(import_node_path.default.sep, "/");
  if (!normalized || normalized.includes("\\") || import_node_path.default.isAbsolute(normalized) || /^[A-Za-z]:[\\/]/u.test(normalized) || /^[\\/]{2}/u.test(normalized)) {
    throw new LocalSearchError(
      "local_search_path_roundtrip_unsafe",
      "Local search found a path that cannot be reused as a logical path."
    );
  }
  return normalized.replace(/^\.\/+/, "");
}
function qualifyMatchPath(context, root, rawPath) {
  const logical = root.isFile ? root.target.logicalPath : root.target.logicalPath === "." ? normalizeRelativeResult(rawPath) : import_node_path.default.posix.join(
    root.target.logicalPath,
    normalizeRelativeResult(rawPath)
  );
  const roundTrip = resolvePluginPath(context, logical, {
    requirePath: true,
    allowedLocations: ["agent_work", "workspace"]
  });
  const sourceAbsolutePath = root.isFile ? root.target.absolutePath : import_node_path.default.resolve(root.target.absolutePath, rawPath);
  if (roundTrip.logicalPath !== logical || import_node_path.default.resolve(roundTrip.absolutePath) !== import_node_path.default.resolve(sourceAbsolutePath)) {
    throw new LocalSearchError(
      "local_search_path_roundtrip_unsafe",
      "Local search found a path that cannot be reused as a logical path."
    );
  }
  return logical;
}

// plugins/local-search/source/ripgrep.ts
var import_node_child_process = require("node:child_process");
var import_node_util = require("node:util");
var import_ripgrep = require("@vscode/ripgrep");
var SEARCH_TIMEOUT_MS = 1e4;
var MAX_PATH_RECORD_BYTES = 64 * 1024;
var MAX_JSON_RECORD_BYTES = 512 * 1024;
var IGNORED_GLOBS = Object.freeze([
  "!.git/**",
  "!node_modules/**",
  "!dist/**",
  "!coverage/**",
  "!.runtime/**"
]);
function rgGlobArgs() {
  return Object.freeze(IGNORED_GLOBS.flatMap((glob) => ["--glob", glob]));
}
function escapeRgGlobLiteral(value) {
  return [...value].map(
    (character) => "\\*?[]{}!".includes(character) ? `\\${character}` : character
  ).join("");
}
function controlledRipgrepEnvironment() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === "RIPGREP_CONFIG_PATH") {
      delete environment[name];
    }
  }
  return environment;
}
function decodeUtf8Record(bytes, kind) {
  let value;
  try {
    value = new import_node_util.TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LocalSearchError(
      "local_search_result_encoding_unsupported",
      `Local search found ${kind === "path" ? "a path" : "text"} with unsupported encoding.`
    );
  }
  return value;
}
function createDelimitedParser(params) {
  let pending = Buffer.alloc(0);
  const parseAvailable = (chunk, includeTrailing, accept) => {
    const combined = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (; ; ) {
      const end = combined.indexOf(params.delimiter, start);
      if (end < 0) break;
      if (end - start > params.maxRecordBytes) {
        throw new LocalSearchError(
          "local_search_result_invalid",
          "Local search returned an oversized result record."
        );
      }
      const parsed = params.parse(combined.subarray(start, end));
      if (parsed !== void 0 && !accept(parsed)) {
        pending = Buffer.alloc(0);
        return;
      }
      start = end + 1;
    }
    const trailing = combined.subarray(start);
    if (trailing.length > params.maxRecordBytes) {
      throw new LocalSearchError(
        "local_search_result_invalid",
        "Local search returned an oversized result record."
      );
    }
    pending = Buffer.from(trailing);
    if (includeTrailing && pending.length > 0) {
      const parsed = params.parse(pending);
      pending = Buffer.alloc(0);
      if (parsed !== void 0) accept(parsed);
    }
  };
  return Object.freeze({
    push: (chunk, accept) => parseAvailable(chunk, false, accept),
    finish: (accept) => parseAvailable(Buffer.alloc(0), true, accept)
  });
}
async function runRipgrepBounded(args, cwd, maxResults, parser, signal, stdinFd) {
  if (signal?.aborted) {
    throw new LocalSearchError(
      "local_search_failed",
      "Local search could not complete under the selected logical root."
    );
  }
  return new Promise((resolve, reject) => {
    const items = [];
    let completed = false;
    let stoppedAfterExtraResult = false;
    let timedOut = false;
    let aborted = false;
    let parserError;
    const child = (0, import_node_child_process.spawn)(import_ripgrep.rgPath, ["--no-config", ...args], {
      cwd,
      env: controlledRipgrepEnvironment(),
      stdio: [stdinFd ?? "ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const cleanup = () => {
      clearTimeout(timeout);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    };
    const settleFailure = (error) => {
      if (completed) return;
      completed = true;
      cleanup();
      reject(
        error instanceof LocalSearchError ? error : new LocalSearchError(
          "local_search_failed",
          "Local search could not complete under the selected logical root."
        )
      );
    };
    const accept = (value, mayStopProcess) => {
      if (items.length < maxResults) {
        items.push(value);
        return true;
      }
      stoppedAfterExtraResult = true;
      if (mayStopProcess) {
        child.stdout.pause();
        child.kill("SIGKILL");
      }
      return false;
    };
    const abortListener = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SEARCH_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.on("data", (chunk) => {
      if (completed || stoppedAfterExtraResult || parserError) return;
      try {
        parser.push(chunk, (value) => accept(value, true));
      } catch (error) {
        parserError = error;
        child.stdout.pause();
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", () => void 0);
    child.on("error", (error) => settleFailure(error));
    child.on("close", (code) => {
      if (completed) return;
      if (parserError) {
        settleFailure(parserError);
        return;
      }
      if (timedOut || aborted) {
        settleFailure();
        return;
      }
      if (!stoppedAfterExtraResult) {
        try {
          parser.finish((value) => accept(value, false));
        } catch (error) {
          settleFailure(error);
          return;
        }
      }
      if (!stoppedAfterExtraResult && code !== 0 && code !== 1) {
        settleFailure();
        return;
      }
      completed = true;
      cleanup();
      resolve(
        Object.freeze({
          items: Object.freeze(items),
          truncated: stoppedAfterExtraResult
        })
      );
    });
    if (signal) {
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    }
  });
}
function requiredJsonText(value) {
  if (!value || typeof value !== "object") {
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data."
    );
  }
  const record = value;
  if (typeof record.text !== "string") {
    if ("bytes" in record) {
      throw new LocalSearchError(
        "local_search_result_encoding_unsupported",
        "Local search found text with unsupported encoding."
      );
    }
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data."
    );
  }
  return record.text;
}
function parseJsonContentEvent(line) {
  if (!line) return void 0;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data."
    );
  }
  if (!event || typeof event !== "object") return void 0;
  const eventRecord = event;
  if (eventRecord.type !== "match") return void 0;
  const data = eventRecord.data;
  if (!data || typeof data !== "object") {
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data."
    );
  }
  const dataRecord = data;
  if (!Number.isSafeInteger(dataRecord.line_number) || Number(dataRecord.line_number) < 1) {
    throw new LocalSearchError(
      "local_search_result_invalid",
      "Local search returned invalid data."
    );
  }
  const text = requiredJsonText(dataRecord.lines);
  return Object.freeze({
    path: requiredJsonText(dataRecord.path),
    lineNumber: Number(dataRecord.line_number),
    text: text.endsWith("\r\n") ? text.slice(0, -2) : text.endsWith("\n") ? text.slice(0, -1) : text
  });
}
function runRipgrepPathSearch(args, cwd, maxResults, signal) {
  return runRipgrepBounded(
    args,
    cwd,
    maxResults,
    createDelimitedParser({
      delimiter: 0,
      maxRecordBytes: MAX_PATH_RECORD_BYTES,
      parse: (record) => decodeUtf8Record(record, "path")
    }),
    signal
  );
}
function runRipgrepContentSearch(args, cwd, maxResults, signal, stdinFd) {
  return runRipgrepBounded(
    args,
    cwd,
    maxResults,
    createDelimitedParser({
      delimiter: 10,
      maxRecordBytes: MAX_JSON_RECORD_BYTES,
      parse: (record) => {
        const normalized = record.at(-1) === 13 ? record.subarray(0, -1) : record;
        return parseJsonContentEvent(decodeUtf8Record(normalized, "result"));
      }
    }),
    signal,
    stdinFd
  );
}

// plugins/local-search/source/index.ts
var DEFAULT_MAX_RESULTS = 40;
var MAX_RESULTS = 200;
function fileNameMatches(logicalPath, query, caseSensitive) {
  const filename = import_node_path2.posix.basename(logicalPath);
  return caseSensitive ? filename.includes(query) : filename.toLowerCase().includes(query.toLowerCase());
}
var index_default = defineRuntimePlugin((context) => ({
  handlers: {
    async local_search(params, executionContext) {
      let root;
      try {
        const query = readRequiredString(params.query, {
          name: "query",
          maxLength: 1024
        });
        const rawMode = readOptionalString(params.mode) ?? "both";
        if (!["names", "content", "both"].includes(rawMode)) {
          return failureResult({
            errorCode: "plugin_parameter_invalid",
            message: "mode must be names, content, or both."
          });
        }
        const mode = rawMode;
        const caseSensitive = readBoolean(params.case_sensitive, {
          defaultValue: false
        });
        const maxResults = readBoundedInteger(params.max_results, {
          defaultValue: DEFAULT_MAX_RESULTS,
          minimum: 1,
          maximum: MAX_RESULTS,
          name: "max_results"
        });
        root = await resolveSearchRoot(context, params.path);
        const candidates = [];
        let sourceTruncated = false;
        if (mode === "names" || mode === "both") {
          const names = root.isFile ? Object.freeze({
            items: Object.freeze(
              fileNameMatches(root.target.logicalPath, query, caseSensitive) ? [import_node_path2.posix.basename(root.target.logicalPath)] : []
            ),
            truncated: false
          }) : await runRipgrepPathSearch(
            [
              "--files",
              "--null",
              "--hidden",
              ...rgGlobArgs(),
              caseSensitive ? "--glob" : "--iglob",
              `*${escapeRgGlobLiteral(query)}*`,
              "--",
              root.commandTarget
            ],
            root.commandDirectory,
            maxResults,
            executionContext?.abortSignal
          );
          sourceTruncated ||= names.truncated;
          for (const rawPath of names.items) {
            candidates.push({
              kind: "name",
              value: qualifyMatchPath(context, root, rawPath)
            });
          }
        }
        if ((mode === "content" || mode === "both") && !sourceTruncated) {
          const remaining = maxResults - candidates.length;
          const content = await runRipgrepContentSearch(
            [
              "--json",
              "--with-filename",
              "--fixed-strings",
              "--line-number",
              "--no-heading",
              "--color",
              "never",
              "--max-columns",
              "2048",
              "--max-columns-preview",
              "--hidden",
              ...caseSensitive ? [] : ["--ignore-case"],
              ...rgGlobArgs(),
              "--",
              query,
              root.commandTarget
            ],
            root.commandDirectory,
            remaining,
            executionContext?.abortSignal,
            root.stdinFd
          );
          sourceTruncated ||= content.truncated;
          for (const match of content.items) {
            candidates.push({
              kind: "content",
              value: {
                ...match,
                path: qualifyMatchPath(context, root, match.path)
              }
            });
          }
        }
        const buildResult = (bounded2) => successResult({
          output: bounded2.output,
          producedNewInformation: true,
          actions: [
            {
              type: "inspect_target",
              target: root.target.logicalPath,
              details: "local_search"
            }
          ],
          data: {
            hasData: bounded2.entries.length > 0,
            itemCount: bounded2.entries.length,
            mode,
            logicalRoot: root.target.logicalPath,
            truncation: bounded2.metadata,
            observationMeta: {
              kind: "volatile_external",
              carryPolicy: "never"
            }
          }
        });
        const bounded = budgetSearchOutput(
          query,
          mode,
          candidates,
          sourceTruncated,
          (candidate) => buildResult(candidate).ok === true
        );
        return buildResult(bounded);
      } catch (error) {
        if (isLocalSearchError(error)) {
          return failureResult({
            errorCode: error.code,
            message: error.message
          });
        }
        return failureFromError(error, {
          fallbackCode: "local_search_failed",
          fallbackMessage: "Local search failed.",
          operation: "local_search"
        });
      } finally {
        await root?.close().catch(() => void 0);
      }
    }
  }
}));
