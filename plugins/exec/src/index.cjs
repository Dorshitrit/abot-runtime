// GENERATED FILE - DO NOT EDIT.
// Source: plugins/exec/source/index.ts
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

// plugins/exec/source/index.ts
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

// src/capabilities/tool-context-text.ts
function hasValidToolContextText(carrier) {
  const fields = carrier.contextTextFields;
  if (fields === void 0) return true;
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > 3)
    return false;
  if (new Set(fields).size !== fields.length) return false;
  for (const field of fields) {
    if (!isContextTextField(field)) return false;
    if (typeof carrier[field] !== "string") return false;
  }
  return true;
}
function isContextTextField(value) {
  return value === "output" || value === "stdout" || value === "stderr";
}

// src/capabilities/result-budget.ts
var CAPABILITY_RESULT_ENVELOPE_MAX_BYTES = 256 * 1024;

// src/plugin-sdk/results.ts
var PLUGIN_RESULT_SERIALIZED_MAX_BYTES = CAPABILITY_RESULT_ENVELOPE_MAX_BYTES;
function resultBoundsFailure(code, message) {
  return {
    ok: false,
    output: message,
    producedNewInformation: false,
    error: message,
    errorCode: code
  };
}
function enforcePluginResultByteBudget(result, resultBudget) {
  let requiresContextTextHost = false;
  let serializedBytes;
  let envelopeBytes;
  let maxBytes = PLUGIN_RESULT_SERIALIZED_MAX_BYTES;
  let fitsDeclaredBudget = true;
  try {
    if (!hasValidToolContextText(result)) {
      return resultBoundsFailure(
        "plugin_context_text_invalid",
        "The plugin declared invalid context text fields."
      );
    }
    requiresContextTextHost = result.contextTextFields !== void 0;
    const lacksContextTextHost = requiresContextTextHost && resultBudget?.acceptsContextText !== true;
    if (lacksContextTextHost) {
      return resultBoundsFailure(
        "plugin_context_text_unavailable",
        "The host does not support context-managed tool text."
      );
    }
    const candidate = JSON.stringify(result);
    if (candidate === void 0) {
      return resultBoundsFailure(
        "plugin_result_not_json_safe",
        "The plugin produced a result that is not JSON-safe."
      );
    }
    const assessment = resultBudget?.assess(result);
    serializedBytes = assessment?.serializedBytes ?? Buffer.byteLength(candidate, "utf8");
    envelopeBytes = assessment?.envelopeBytes ?? serializedBytes;
    maxBytes = Math.min(assessment?.maxBytes ?? maxBytes, maxBytes);
    fitsDeclaredBudget = assessment?.fits ?? true;
  } catch {
    return resultBoundsFailure(
      "plugin_result_not_json_safe",
      "The plugin produced a result that is not JSON-safe."
    );
  }
  const hasResultDeliveryHeadroom = fitsDeclaredBudget && envelopeBytes <= maxBytes;
  if (!hasResultDeliveryHeadroom) {
    const message = requiresContextTextHost ? `The plugin result envelope is ${envelopeBytes} bytes (${serializedBytes} total bytes) and exceeds the ${maxBytes}-byte delivery limit.` : `The plugin result is ${serializedBytes} bytes and exceeds the ${maxBytes}-byte delivery limit.`;
    return resultBoundsFailure("plugin_result_too_large", message);
  }
  return result;
}
function failureResult(input, resultBudget) {
  return enforcePluginResultByteBudget(
    {
      ok: false,
      ...input.interruption ? { interruption: input.interruption } : {},
      ...input.media !== void 0 ? { media: input.media } : {},
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
    },
    resultBudget
  );
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

// src/plugin-sdk/context-text-result.ts
function deliverPluginTextResult(result, fields, budget) {
  const assessed = enforcePluginResultByteBudget(result, budget);
  if (!canHandOffContextText(result, assessed, budget)) return assessed;
  return enforcePluginResultByteBudget(
    { ...result, contextTextFields: Object.freeze([...fields]) },
    budget
  );
}
function canHandOffContextText(original, assessed, budget) {
  if (budget?.acceptsContextText !== true) return false;
  if (assessed === original) return false;
  return assessed.errorCode === "plugin_result_too_large";
}

// src/capabilities/tool-media.ts
var TOOL_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

// plugins/exec/source/filesystem-observer.ts
var import_promises2 = require("node:fs/promises");
var import_node_path = require("node:path");

// plugins/exec/source/filesystem-file-observer.ts
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var SNAPSHOT_MAX_HASHED_FILE_BYTES = 2 * 1024 * 1024;
function isMissingPathError(error) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
function hashBuffer(content) {
  return (0, import_node_crypto.createHash)("sha256").update(content).digest("hex");
}
async function inspectExecRegularFile(absolutePath, remainingHashBytes) {
  if (process.platform === "win32") {
    const info = await (0, import_promises.lstat)(absolutePath).catch((error) => {
      if (isMissingPathError(error)) return null;
      throw error;
    });
    if (!info?.isFile()) return void 0;
    return Object.freeze({
      entry: Object.freeze({
        kind: "file",
        mode: info.mode,
        size: info.size,
        mtimeMs: info.mtimeMs
      }),
      hashedBytes: 0
    });
  }
  const noFollow = import_node_fs.constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) return void 0;
  let file;
  try {
    file = await (0, import_promises.open)(absolutePath, import_node_fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (isMissingPathError(error) || error instanceof Error && "code" in error && error.code === "ELOOP") {
      return void 0;
    }
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) return void 0;
    let contentHash;
    let hashedBytes = 0;
    if (info.size <= SNAPSHOT_MAX_HASHED_FILE_BYTES && info.size <= remainingHashBytes) {
      const length = Math.max(0, Math.floor(info.size));
      const content = Buffer.alloc(length);
      while (hashedBytes < length) {
        const { bytesRead } = await file.read(
          content,
          hashedBytes,
          length - hashedBytes,
          hashedBytes
        );
        if (bytesRead === 0) break;
        hashedBytes += bytesRead;
      }
      contentHash = hashBuffer(content.subarray(0, hashedBytes));
    }
    return Object.freeze({
      entry: Object.freeze({
        kind: "file",
        mode: info.mode,
        size: info.size,
        mtimeMs: info.mtimeMs,
        ...contentHash === void 0 ? {} : { contentHash }
      }),
      hashedBytes
    });
  } finally {
    await file.close();
  }
}

// plugins/exec/source/filesystem-observer.ts
var SNAPSHOT_MAX_ENTRIES = 4096;
var SNAPSHOT_MAX_HASHED_BYTES = 16 * 1024 * 1024;
var DELTA_ACTION_LIMIT = 64;
var ACTION_TARGET_MAX_CHARS = 96;
async function readBoundedDirectory(absoluteDirectory, maxItems) {
  let directory;
  try {
    directory = await (0, import_promises2.opendir)(absoluteDirectory);
  } catch (error) {
    if (isMissingPathError(error)) {
      return Object.freeze({ children: Object.freeze([]), complete: true });
    }
    throw error;
  }
  const children = [];
  let complete = true;
  try {
    while (true) {
      const child = await directory.read();
      if (!child) break;
      if (children.length >= maxItems) {
        complete = false;
        break;
      }
      children.push(child);
    }
  } finally {
    await directory.close().catch((error) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_DIR_CLOSED") {
        throw error;
      }
    });
  }
  children.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({ children: Object.freeze(children), complete });
}
async function captureExecFilesystemSnapshot(absoluteRoot, logicalRoot) {
  const entries = /* @__PURE__ */ new Map();
  let remainingHashBytes = SNAPSHOT_MAX_HASHED_BYTES;
  let complete = true;
  const rootInfo = await (0, import_promises2.lstat)(absoluteRoot).catch((error) => {
    if (isMissingPathError(error)) return null;
    throw error;
  });
  if (!rootInfo) {
    return Object.freeze({
      absoluteRoot,
      logicalRoot,
      rootExists: false,
      complete: true,
      entries
    });
  }
  const pendingDirectories = [""];
  while (pendingDirectories.length > 0 && complete) {
    const relativeDirectory = pendingDirectories.pop() ?? "";
    const absoluteDirectory = relativeDirectory ? (0, import_node_path.join)(absoluteRoot, relativeDirectory) : absoluteRoot;
    const directory = await readBoundedDirectory(
      absoluteDirectory,
      SNAPSHOT_MAX_ENTRIES - entries.size
    );
    for (const child of directory.children) {
      const relativePath = relativeDirectory ? (0, import_node_path.join)(relativeDirectory, child.name) : child.name;
      const absolutePath = (0, import_node_path.join)(absoluteRoot, relativePath);
      const info = await (0, import_promises2.lstat)(absolutePath).catch((error) => {
        if (isMissingPathError(error)) return null;
        throw error;
      });
      if (!info) continue;
      if (info.isDirectory()) {
        entries.set(
          relativePath,
          Object.freeze({
            kind: "directory",
            mode: info.mode,
            size: info.size,
            mtimeMs: info.mtimeMs
          })
        );
        pendingDirectories.push(relativePath);
        continue;
      }
      if (info.isSymbolicLink()) {
        const linkTarget = await (0, import_promises2.readlink)(absolutePath).catch(() => void 0);
        entries.set(
          relativePath,
          Object.freeze({
            kind: "symlink",
            mode: info.mode,
            size: info.size,
            mtimeMs: info.mtimeMs,
            ...linkTarget === void 0 ? {} : { linkTarget }
          })
        );
        continue;
      }
      if (info.isFile()) {
        const inspected = await inspectExecRegularFile(
          absolutePath,
          remainingHashBytes
        );
        if (!inspected) {
          complete = false;
          continue;
        }
        entries.set(relativePath, inspected.entry);
        remainingHashBytes -= inspected.hashedBytes;
        continue;
      }
      entries.set(
        relativePath,
        Object.freeze({
          kind: "other",
          mode: info.mode,
          size: info.size,
          mtimeMs: info.mtimeMs
        })
      );
    }
    if (!directory.complete) complete = false;
  }
  return Object.freeze({
    absoluteRoot,
    logicalRoot,
    rootExists: true,
    complete,
    entries
  });
}
function entryChanged(before, after) {
  if (before.kind !== after.kind || before.mode !== after.mode) return true;
  if (before.kind === "directory") return false;
  if (before.kind === "symlink") return before.linkTarget !== after.linkTarget;
  if (before.kind === "file" && before.contentHash !== void 0 && after.contentHash !== void 0) {
    return before.contentHash !== after.contentHash;
  }
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}
function logicalChild(root, relativePath) {
  const target = sanitizeJsonText(
    root === "." ? relativePath.replaceAll("\\", "/") : import_node_path.posix.join(root, relativePath.replaceAll("\\", "/"))
  );
  const characters = [...target];
  if (characters.length <= ACTION_TARGET_MAX_CHARS) return target;
  const separator = "…";
  const sideChars = Math.floor(
    (ACTION_TARGET_MAX_CHARS - separator.length) / 2
  );
  return `${characters.slice(0, sideChars).join("")}${separator}${characters.slice(-sideChars).join("")}`;
}
function actionForDelta(params) {
  const target = logicalChild(params.logicalRoot, params.relativePath);
  if (!params.before && params.after?.kind === "directory") {
    return { type: "mkdir", target, details: "exec_filesystem_created" };
  }
  if (!params.before && params.after?.kind === "file") {
    return { type: "write_file", target, details: "exec_filesystem_created" };
  }
  return {
    type: "refine_target",
    target,
    details: params.after ? "exec_filesystem_modified" : "exec_filesystem_removed"
  };
}
function diffExecFilesystemSnapshots(before, after) {
  if (before.absoluteRoot !== after.absoluteRoot || before.logicalRoot !== after.logicalRoot) {
    throw new TypeError(
      "Exec filesystem snapshots must share one observation root."
    );
  }
  let changes;
  if (before.rootExists !== after.rootExists) {
    changes = [{ relativePath: "" }];
  } else if (!before.rootExists) {
    changes = [];
  } else {
    const candidatePaths = before.complete && after.complete ? /* @__PURE__ */ new Set([...before.entries.keys(), ...after.entries.keys()]) : new Set(
      [...before.entries.keys()].filter(
        (entry) => after.entries.has(entry)
      )
    );
    changes = [...candidatePaths].sort((left, right) => left.localeCompare(right)).flatMap((relativePath) => {
      const beforeEntry = before.entries.get(relativePath);
      const afterEntry = after.entries.get(relativePath);
      return beforeEntry === void 0 || afterEntry === void 0 || entryChanged(beforeEntry, afterEntry) ? [
        {
          relativePath,
          ...beforeEntry === void 0 ? {} : { before: beforeEntry },
          ...afterEntry === void 0 ? {} : { after: afterEntry }
        }
      ] : [];
    });
  }
  const actions = changes.slice(0, DELTA_ACTION_LIMIT).map(
    (entry) => entry.relativePath ? actionForDelta({ logicalRoot: before.logicalRoot, ...entry }) : {
      type: "refine_target",
      target: logicalChild(".", before.logicalRoot),
      details: after.rootExists ? "exec_filesystem_created" : "exec_filesystem_removed"
    }
  );
  return Object.freeze({
    observedStateChange: changes.length > 0,
    changedEntryCount: changes.length,
    actions: Object.freeze(actions),
    observation: Object.freeze({
      complete: before.complete && after.complete,
      actionLimit: DELTA_ACTION_LIMIT,
      actionsTruncated: changes.length > actions.length
    })
  });
}

// plugins/exec/source/result-presentation.ts
var EXEC_CONTEXT_TEXT_FIELDS = Object.freeze(["stdout", "stderr"]);
function streamReceipt(snapshot, field) {
  if (snapshot.text) return `See the ${field} field (${snapshot.text.length} characters).`;
  return snapshot.sawOutput ? "(no new output; earlier output was already returned)" : "(empty)";
}
function renderedOutput(lines) {
  const output = lines.join("\n");
  return Object.freeze({
    output,
    metadata: Object.freeze({
      truncated: false,
      originalChars: output.length,
      returnedChars: output.length,
      omittedChars: 0
    })
  });
}
function outputBoundsData(snapshot, rendered) {
  return Object.freeze({
    maxChars: null,
    stdout: snapshot.stdout.metadata,
    stderr: snapshot.stderr.metadata,
    rendered
  });
}
function runningResult(snapshot, execution, resultBudget) {
  const nextCursor = snapshot.nextCursor ?? 1;
  const rendered = renderedOutput(
    [
      `Command: ${execution.commandPreview}`,
      `CWD: ${execution.cwd.logicalPath}`,
      "Process status: running",
      `Process ID: ${snapshot.processId}`,
      `Next cursor: ${nextCursor}`,
      "STDOUT since the previous observation:",
      streamReceipt(snapshot.stdout, "stdout"),
      "STDERR since the previous observation:",
      streamReceipt(snapshot.stderr, "stderr"),
      "Continue this exact process with exec_wait; do not run the command again."
    ]
  );
  return deliverPluginTextResult({
    ok: false,
    producedNewInformation: false,
    errorCode: "exec_process_running",
    error: "The command is still running. Continue it with exec_wait using the returned process ID and cursor.",
    output: rendered.output,
    stdout: snapshot.stdout.text,
    stderr: snapshot.stderr.text,
    data: {
      processId: snapshot.processId,
      processStatus: "running",
      nextCursor,
      outputBounds: outputBoundsData(snapshot, rendered.metadata),
      observationMeta: {
        kind: "volatile_external",
        carryPolicy: "never"
      }
    }
  }, EXEC_CONTEXT_TEXT_FIELDS, resultBudget);
}
async function captureFilesystemDelta(execution) {
  if (!execution.filesystemStateBefore) return null;
  try {
    const after = await captureExecFilesystemSnapshot(
      execution.cwd.absolutePath,
      execution.cwd.logicalPath
    );
    return diffExecFilesystemSnapshots(execution.filesystemStateBefore, after);
  } catch {
    return null;
  }
}
function projectExecFilesystemEvidence(delta, logicalRoot) {
  const effects = delta.actions.map(renderExecFilesystemEffect);
  const omittedEffectCount = Math.max(
    0,
    delta.changedEntryCount - effects.length
  );
  const omittedEffectLine = omittedEffectCount > 0 ? `- ${omittedEffectCount} additional changed ${omittedEffectCount === 1 ? "entry" : "entries"} omitted by the ${delta.observation.actionLimit}-effect projection limit.` : void 0;
  const outputLines = Object.freeze([
    `Filesystem changes observed: ${delta.changedEntryCount}${delta.observation.complete ? "" : " (bounded observation)"}`,
    "Filesystem effects observed:",
    ...effects,
    ...omittedEffectLine ? [omittedEffectLine] : []
  ]);
  return Object.freeze({
    outputLines,
    mutationGrounding: [
      "Observed post-command filesystem effects (settled tool evidence; not command intent, semantic verification, or complete artifact content):",
      `- observation root: ${logicalRoot}`,
      `- observation complete: ${delta.observation.complete}`,
      `- changed entries: ${delta.changedEntryCount}`,
      `- listed effects: ${effects.length}`,
      `- effects truncated: ${delta.observation.actionsTruncated}`,
      "Effects:",
      ...effects,
      ...omittedEffectLine ? [omittedEffectLine] : []
    ].join("\n")
  });
}
function renderExecFilesystemEffect(action) {
  const target = action.target ? `: ${action.target}` : "";
  const state = action.details === "exec_filesystem_created" ? "created" : action.details === "exec_filesystem_modified" ? "modified" : action.details === "exec_filesystem_removed" ? "removed" : void 0;
  return `- ${action.type}${target}${state ? ` (${state})` : ""}`;
}
async function finalizeExecResult(params) {
  const { snapshot, execution } = params;
  const exitCode = snapshot.exitCode ?? -1;
  const cancellationIsSuccess = params.cancellationIsSuccess === true && snapshot.terminationReason === "cancelled";
  const filesystemDelta = await captureFilesystemDelta(execution);
  const observedStateChange = filesystemDelta?.observedStateChange === true;
  const filesystemEvidence = observedStateChange && filesystemDelta ? projectExecFilesystemEvidence(
    filesystemDelta,
    execution.cwd.logicalPath
  ) : null;
  const commandHasData = snapshot.stdout.sawOutput || snapshot.stderr.sawOutput;
  const ok = exitCode === 0 || cancellationIsSuccess;
  const inconclusiveSuccess = exitCode === 0 && !commandHasData && !observedStateChange;
  const producedNewInformation = observedStateChange || cancellationIsSuccess || ok && commandHasData;
  const actions = filesystemDelta?.actions ?? [];
  const resultSummary = cancellationIsSuccess ? "Result summary: the running command was cancelled." : inconclusiveSuccess ? "Result summary: the command completed without observable output or filesystem change. Inspect a concrete target or use a dedicated creation capability." : "";
  const rendered = renderedOutput(
    [
      `Command: ${execution.commandPreview}`,
      `CWD: ${execution.cwd.logicalPath}`,
      `Process ID: ${snapshot.processId}`,
      `Process status: ${snapshot.terminationReason ?? "completed"}`,
      `Exit code: ${exitCode}`,
      ...filesystemEvidence ? filesystemEvidence.outputLines : [],
      "STDOUT:",
      streamReceipt(snapshot.stdout, "stdout"),
      "STDERR:",
      streamReceipt(snapshot.stderr, "stderr"),
      ...resultSummary ? [resultSummary] : []
    ]
  );
  const processStatus = snapshot.terminationReason ?? "completed";
  const data = {
    ...commandHasData ? { hasData: true } : {},
    ...observedStateChange ? { mutationEvidence: true } : {},
    ...filesystemEvidence ? { mutationGrounding: filesystemEvidence.mutationGrounding } : {},
    processId: snapshot.processId,
    processStatus,
    outputBounds: outputBoundsData(snapshot, rendered.metadata),
    ...filesystemDelta ? { filesystemObservation: filesystemDelta.observation } : { filesystemObservation: { available: false } },
    observationMeta: {
      kind: "volatile_external",
      carryPolicy: "never"
    }
  };
  const common = {
    output: rendered.output,
    progress: observedStateChange || cancellationIsSuccess,
    producedNewInformation,
    actions: [...actions],
    exitCode,
    stdout: snapshot.stdout.text,
    stderr: snapshot.stderr.text,
    data
  };
  if (ok && (!inconclusiveSuccess || cancellationIsSuccess)) {
    return deliverPluginTextResult({ ok: true, ...common }, EXEC_CONTEXT_TEXT_FIELDS, params.resultBudget);
  }
  const errorCode = inconclusiveSuccess ? "no_observable_result" : snapshot.terminationReason === "aborted" ? "exec_aborted" : snapshot.terminationReason === "spawn_failed" ? "exec_spawn_failed" : snapshot.terminationReason === "idle_timeout" ? "exec_idle_timeout" : snapshot.terminationReason === "hard_timeout" ? "exec_hard_timeout" : "non_zero_exit";
  const error = inconclusiveSuccess ? resultSummary : errorCode === "exec_aborted" ? "The exec request was aborted." : errorCode === "exec_spawn_failed" ? "The runtime could not start the configured non-interactive shell." : errorCode === "exec_idle_timeout" ? `The command produced no output for ${execution.idleTimeoutMs}ms.` : errorCode === "exec_hard_timeout" ? `The command exceeded the ${execution.hardTimeoutMs}ms hard timeout.` : `The command exited with code ${exitCode}.`;
  return deliverPluginTextResult({
    ok: false,
    ...common,
    error,
    errorCode
  }, EXEC_CONTEXT_TEXT_FIELDS, params.resultBudget);
}

// plugins/exec/source/retained-output-failure.ts
function retainedOutputFailure(snapshot, context) {
  const expired = hasUnavailableOutput(snapshot);
  return failureResult(
    {
      errorCode: expired ? "exec_output_expired" : snapshot.outputFailure ? "exec_output_storage_failed" : "exec_output_delivery_pending",
      message: expired ? "The retained output expired or is no longer available. The command was already started; it has not been run again." : snapshot.outputFailure ? "Output storage or delivery failed. The command was already started; do not run it again. Any committed bytes are retained for the configured retention period; complete output delivery is not confirmed." : "The output exceeds the delivery envelope and remains retained. The command was already executed; do not run it again.",
      data: {
        processId: snapshot.processId,
        processStatus: snapshot.status,
        nextCursor: snapshot.nextCursor,
        ...snapshot.exitCode !== void 0 ? { exitCode: snapshot.exitCode } : {},
        ...snapshot.terminationReason ? { terminationReason: snapshot.terminationReason } : {},
        outputDelivery: expired ? "expired" : "pending",
        ...snapshot.outputFailure ? { outputStorageFailure: snapshot.outputFailure } : {},
        retainedCharacters: snapshot.stdout.text.length + snapshot.stderr.text.length
      }
    },
    context?.resultBudget
  );
}
function hasUnavailableOutput(snapshot) {
  if (snapshot.outputFailure?.code === "exec_output_expired") return true;
  return snapshot.outputFailure?.code === "exec_output_expired_or_unavailable";
}

// plugins/exec/source/errors.ts
var ExecPluginError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "ExecPluginError";
    this.code = code;
  }
};
function execFailureFromError(error, operation) {
  if (error instanceof ExecPluginError) {
    return failureResult({
      errorCode: error.code,
      message: error.message,
      output: `${operation} failed: ${error.message}`
    });
  }
  return failureFromError(error, {
    fallbackCode: `${operation}_failed`,
    fallbackMessage: `${operation} failed without a safe diagnostic.`,
    operation
  });
}

// plugins/exec/source/terminal-delivery.ts
var import_node_crypto2 = require("node:crypto");
var ExecTerminalDelivery = class {
  claim;
  accepted = false;
  get isClaimed() {
    return this.claim !== void 0;
  }
  assertAvailable() {
    if (this.isClaimed) throw this.unavailable();
  }
  reserve(snapshot) {
    if (snapshot.status !== "settled") return snapshot;
    this.assertAvailable();
    this.claim = (0, import_node_crypto2.randomUUID)();
    return Object.freeze({ ...snapshot, deliveryId: this.claim });
  }
  assertOwner(snapshot) {
    if (snapshot.status !== "settled") return;
    if (!this.claim || snapshot.deliveryId !== this.claim || this.accepted)
      throw this.unavailable();
  }
  accept(snapshot) {
    if (snapshot.status !== "settled") return;
    this.assertOwner(snapshot);
    this.accepted = true;
  }
  reject(snapshot) {
    if (this.accepted) return;
    if (snapshot.deliveryId !== this.claim) return;
    this.claim = void 0;
  }
  unavailable() {
    return new ExecPluginError(
      "unknown_exec_process",
      "The terminal exec result is already claimed by another observation."
    );
  }
};

// plugins/exec/source/output-files.ts
var import_node_crypto3 = require("node:crypto");
var import_promises3 = require("node:fs/promises");
var import_node_path2 = require("node:path");
var ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function outputStorageRoot(stateDir) {
  if (!stateDir.trim()) throw outputFailure("state_dir_invalid");
  return (0, import_node_path2.resolve)(stateDir, "output");
}
function outputOwnerDirectory(root, ownerId) {
  if (!ownerId.trim()) throw outputFailure("owner_invalid");
  return (0, import_node_path2.join)(root, (0, import_node_crypto3.createHash)("sha256").update(ownerId).digest("hex"));
}
function outputStreamPath(directory, id) {
  assertOutputId(id);
  return (0, import_node_path2.join)(directory, `${id}.bytes`);
}
function outputSnapshotPath(directory, id) {
  assertOutputId(id);
  return (0, import_node_path2.join)(directory, `${id}.snapshot.json`);
}
function assertOutputId(id) {
  if (typeof id !== "string" || !ID.test(id)) throw outputFailure("id_invalid");
}
function outputFailure(code, cause) {
  const error = new ExecPluginError(
    `exec_output_${code}`,
    `Exec output storage failed: ${code}.`
  );
  if (cause !== void 0)
    Object.defineProperty(error, "cause", { value: cause });
  return error;
}
async function writeOutputMetadata(path, value) {
  const temporary = `${path}.${(0, import_node_crypto3.randomUUID)()}.tmp`;
  try {
    const file = await (0, import_promises3.open)(temporary, "wx", 384);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await (0, import_promises3.rename)(temporary, path);
    await syncOutputDirectoryEntry(path);
  } catch (error) {
    await (0, import_promises3.rm)(temporary, { force: true }).catch(() => void 0);
    throw outputFailure("metadata_write_failed", error);
  }
}
async function syncOutputDirectoryEntry(path) {
  if (process.platform === "win32") return;
  const directory = await (0, import_promises3.open)((0, import_node_path2.dirname)(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function prepareOutputOwnerDirectory(directory) {
  try {
    await (0, import_promises3.mkdir)(directory, { recursive: true, mode: 448 });
  } catch (error) {
    throw outputFailure("write_failed", error);
  }
}
async function readOutputOwner(directory) {
  let value;
  try {
    value = JSON.parse(await (0, import_promises3.readFile)((0, import_node_path2.join)(directory, "owner.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw outputFailure("owner_read_failed", error);
  }
  if (!isOutputOwnerRecord(value)) throw outputFailure("owner_invalid");
  return value;
}
function isOutputOwnerRecord(value) {
  if (!value || typeof value !== "object") return false;
  const owner = value;
  if (owner.kind !== "exec_output_owner_v1") return false;
  if (typeof owner.ownerId !== "string" || !owner.ownerId.trim()) return false;
  return owner.completedAt === null || Number.isSafeInteger(owner.completedAt) && owner.completedAt >= 0;
}
async function lookupOutputSnapshot(directory, ownerId, id) {
  let value;
  try {
    value = JSON.parse(
      await (0, import_promises3.readFile)(outputSnapshotPath(directory, id), "utf8")
    );
  } catch (error) {
    throw outputFailure("snapshot_unavailable", error);
  }
  if (!isStoredOutputSnapshot(value, ownerId, id))
    throw outputFailure("snapshot_binding_invalid");
  return value;
}
function isStoredOutputSnapshot(value, ownerId, id) {
  if (!value || typeof value !== "object") return false;
  const snapshot = value;
  if (snapshot.kind !== "exec_output_snapshot_v1" || snapshot.ownerId !== ownerId)
    return false;
  if (typeof snapshot.streamId !== "string" || !ID.test(snapshot.streamId))
    return false;
  const body = snapshot.body;
  if (!body || typeof body !== "object" || body.id !== id) return false;
  return isExecOutputBody(body);
}
function isExecOutputBody(value) {
  if (!value || typeof value !== "object") return false;
  const body = value;
  if (typeof body.id !== "string" || !ID.test(body.id)) return false;
  if (body.stream !== "stdout" && body.stream !== "stderr") return false;
  if (!Number.isSafeInteger(body.startByte) || body.startByte < 0) return false;
  if (!Number.isSafeInteger(body.endByte) || body.endByte < body.startByte)
    return false;
  if (body.byteLength !== body.endByte - body.startByte) return false;
  return typeof body.sha256 === "string" && /^sha256:[a-f0-9]{64}$/.test(body.sha256);
}
async function readOutputSnapshot(directory, ownerId, body) {
  const snapshot = await lookupOutputSnapshot(directory, ownerId, body.id);
  const stored = snapshot.body;
  if (stored.stream !== body.stream || stored.startByte !== body.startByte || stored.endByte !== body.endByte || stored.byteLength !== body.byteLength || stored.sha256 !== body.sha256)
    throw outputFailure("snapshot_binding_invalid");
  return snapshot;
}

// plugins/exec/source/request-resources.ts
var ExecRequestResources = class {
  constructor(manager, pending, preparation) {
    this.manager = manager;
    this.pending = pending;
    const state = preparation?.requestState;
    if (!state) return;
    const saved = state.read("exec.terminal.v1");
    if (saved !== void 0) this.restore(saved);
    state.register("exec.terminal.v1", {
      snapshot: () => this.snapshot(),
      dispose: () => this.dispose()
    });
  }
  manager;
  pending;
  owned = /* @__PURE__ */ new Map();
  restored = /* @__PURE__ */ new Map();
  deliveries = /* @__PURE__ */ new Map();
  started(processId, scope, settled, context) {
    this.owned.set(processId, scope);
    context?.requestWork?.trackUntil(settled);
  }
  forget(processId) {
    this.owned.delete(processId);
    this.restored.delete(processId);
    this.deliveries.delete(processId);
  }
  isRestored(processId) {
    return this.restored.has(processId);
  }
  terminal(processId, scope, cursor) {
    const entry = this.restored.get(processId);
    if (!entry) return void 0;
    if (entry.scope !== scope)
      throw new ExecPluginError(
        "unknown_exec_process",
        "The exec process belongs to a different session."
      );
    if (cursor !== void 0 && cursor !== entry.cursor)
      throw new ExecPluginError(
        "stale_exec_process_cursor",
        "The saved exec cursor is stale."
      );
    return this.deliveries.get(processId).reserve({
      ...structuredClone(entry.snapshot),
      nextCursor: entry.cursor
    });
  }
  rejectTerminal(snapshot) {
    this.deliveries.get(snapshot.processId)?.reject(snapshot);
  }
  snapshot() {
    for (const delivery of this.deliveries.values()) delivery.assertAvailable();
    const executions = [...this.restored.values()];
    for (const [processId, scope] of this.owned) {
      const execution = this.pending.get(processId);
      if (!execution) continue;
      const terminal = this.manager.snapshotSettled(processId, scope);
      const before = execution.filesystemStateBefore;
      executions.push({
        processId,
        scope,
        ...terminal,
        execution: {
          ...execution,
          filesystemStateBefore: before ? { ...before, entries: [...before.entries] } : null
        }
      });
    }
    return { kind: "exec_terminal_state_v2", executions };
  }
  restore(value) {
    if (!isRecord(value) || value.kind !== "exec_terminal_state_v1" && value.kind !== "exec_terminal_state_v2" || !Array.isArray(value.executions))
      throw invalid();
    for (const entry of value.executions) {
      if (!isSavedExecution(entry) || this.restored.has(entry.processId))
        throw invalid();
      const before = entry.execution.filesystemStateBefore;
      this.restored.set(entry.processId, structuredClone(entry));
      this.deliveries.set(entry.processId, new ExecTerminalDelivery());
      this.pending.set(entry.processId, {
        ...structuredClone(entry.execution),
        filesystemStateBefore: before ? { ...before, entries: new Map(before.entries) } : null
      });
    }
  }
  async dispose() {
    for (const [processId, scope] of this.owned) {
      try {
        await this.manager.cancel({ processId, scope });
      } catch {
      }
      try {
        await this.manager.release(processId, scope);
      } catch {
      }
      this.pending.delete(processId);
    }
    for (const id of this.restored.keys()) this.pending.delete(id);
    this.owned.clear();
    this.restored.clear();
    this.deliveries.clear();
  }
};
function isSavedExecution(value) {
  if (!isRecord(value) || typeof value.processId !== "string" || typeof value.scope !== "string" || !Number.isSafeInteger(value.cursor) || value.cursor < 1 || !isRecord(value.snapshot) || value.snapshot.processId !== value.processId || value.snapshot.status !== "settled" || !isStream(value.snapshot.stdout, "stdout") || !isStream(value.snapshot.stderr, "stderr") || !Number.isFinite(value.snapshot.elapsedMs) || !isRecord(value.execution) || typeof value.execution.commandPreview !== "string" || !isRecord(value.execution.cwd) || typeof value.execution.cwd.absolutePath !== "string" || typeof value.execution.cwd.logicalPath !== "string")
    return false;
  if (![value.execution.hardTimeoutMs, value.execution.idleTimeoutMs].every(
    Number.isFinite
  ))
    return false;
  const before = value.execution.filesystemStateBefore;
  return before === null || isRecord(before) && typeof before.absoluteRoot === "string" && typeof before.logicalRoot === "string" && typeof before.rootExists === "boolean" && typeof before.complete === "boolean" && Array.isArray(before.entries) && before.entries.every(
    (entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && isRecord(entry[1]) && typeof entry[1].kind === "string" && [entry[1].mode, entry[1].size, entry[1].mtimeMs].every(
      Number.isFinite
    )
  );
}
function isStream(value, stream) {
  return isRecord(value) && typeof value.text === "string" && typeof value.sawOutput === "boolean" && (value.body === void 0 || isExecOutputBody(value.body) && value.body.stream === stream) && isRecord(value.metadata) && typeof value.metadata.truncated === "boolean" && [
    value.metadata.originalChars,
    value.metadata.returnedChars,
    value.metadata.omittedChars
  ].every(Number.isFinite);
}
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function invalid() {
  return new Error("exec_terminal_snapshot_invalid");
}

// plugins/exec/source/paths.ts
var import_promises4 = require("node:fs/promises");
var import_node_path3 = require("node:path");
function resolveContextualDirectory(pluginContext, executionContext, requestedPath) {
  if ((0, import_node_path3.isAbsolute)(requestedPath)) return { absolutePath: requestedPath };
  const isWorkspaceAlias = requestedPath === "workspace" || requestedPath.startsWith("workspace/");
  const base = resolvePluginPath(
    {
      runtimePathResolver: executionContext?.runtimePathResolver ?? pluginContext.runtimePathResolver
    },
    isWorkspaceAlias ? "workspace" : ".",
    { allowedLocations: [isWorkspaceAlias ? "workspace" : "agent_work"] }
  );
  const relativePath = isWorkspaceAlias ? requestedPath.slice("workspace".length + 1) || "." : requestedPath;
  return { absolutePath: `${base.absolutePath}${import_node_path3.sep}${relativePath}`, base };
}
function isOutsideExecContextBase(relativePath) {
  if (relativePath === "..") return true;
  if (relativePath.startsWith(`..${import_node_path3.sep}`)) return true;
  return (0, import_node_path3.isAbsolute)(relativePath);
}
function logicalDirectory(absolutePath, base) {
  if (!base) return absolutePath;
  const fromBase = (0, import_node_path3.relative)(base.absolutePath, absolutePath);
  if (isOutsideExecContextBase(fromBase)) return absolutePath;
  return import_node_path3.posix.join(base.logicalPath, fromBase.split(import_node_path3.sep).join("/") || ".");
}
async function resolveExecWorkingDirectory(pluginContext, executionContext, rawPath) {
  const inputPath = readRequiredString(rawPath, {
    name: "cwd",
    trim: false,
    maxLength: 4096
  });
  const requestedPath = process.platform === "win32" ? inputPath.replaceAll("\\", "/") : inputPath;
  if (requestedPath.includes("\0")) {
    throw new ExecPluginError(
      "exec_cwd_invalid",
      "The selected cwd contains NUL characters."
    );
  }
  const target = resolveContextualDirectory(
    pluginContext,
    executionContext,
    requestedPath
  );
  let absolutePath;
  let info;
  try {
    absolutePath = await (0, import_promises4.realpath)(target.absolutePath);
    info = await (0, import_promises4.stat)(absolutePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ExecPluginError(
        "exec_cwd_not_found",
        "The selected cwd does not exist. Select an existing directory."
      );
    }
    throw new ExecPluginError(
      "exec_cwd_inaccessible",
      "The selected cwd cannot be accessed by the runtime."
    );
  }
  if (!info.isDirectory()) {
    throw new ExecPluginError(
      "exec_cwd_not_directory",
      "The selected cwd is not a directory."
    );
  }
  return Object.freeze({
    absolutePath,
    logicalPath: logicalDirectory(absolutePath, target.base)
  });
}

// plugins/exec/source/process-manager.ts
var import_node_crypto6 = require("node:crypto");
var import_node_os = require("node:os");
var import_node_path7 = require("node:path");

// plugins/exec/source/process-output.ts
function streamReceipt2(body) {
  return {
    text: "",
    sawOutput: (body?.endByte ?? 0) > 0,
    metadata: {
      truncated: false,
      originalChars: 0,
      returnedChars: 0,
      omittedChars: 0
    },
    ...body ? { body } : {}
  };
}
async function createExecProcessOutput(store, ownerId) {
  const stdout = await store.createWriter({ ownerId, stream: "stdout" });
  let stderr;
  try {
    stderr = await store.createWriter({ ownerId, stream: "stderr" });
  } catch (error) {
    await stdout.dispose();
    throw error;
  }
  const offsets = { stdout: 0, stderr: 0 };
  let settled;
  let failure;
  let finished2 = false;
  let tail = Promise.resolve();
  const serialize = async (operation) => {
    const previous = tail;
    let release = () => {
    };
    tail = new Promise((resolve2) => {
      release = resolve2;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const recordFailure = (error) => {
    failure ??= error instanceof Error ? error.message : "exec_output_write_failed";
  };
  const capture = async () => {
    try {
      const out = await stdout.snapshot({
        startByte: offsets.stdout,
        endByte: finished2 ? stdout.byteLength : stdout.utf8ByteLength
      });
      const err = await stderr.snapshot({
        startByte: offsets.stderr,
        endByte: finished2 ? stderr.byteLength : stderr.utf8ByteLength
      });
      return {
        stdout: streamReceipt2(out),
        stderr: streamReceipt2(err),
        ...failureReceipt()
      };
    } catch (error) {
      recordFailure(error);
      return {
        stdout: streamReceipt2(),
        stderr: streamReceipt2(),
        ...failureReceipt()
      };
    }
  };
  const failureReceipt = () => failure ? {
    outputFailure: {
      code: failure,
      stdoutBytes: stdout.byteLength,
      stderrBytes: stderr.byteLength
    }
  } : {};
  return Object.freeze({
    attach(streams, onActivity, onFailure) {
      for (const name of ["stdout", "stderr"]) {
        const source = streams[name];
        const writer = name === "stdout" ? stdout : stderr;
        source.on("data", onActivity);
        const failed = (error) => {
          recordFailure(error);
          source.pause();
          onFailure();
        };
        writer.sink.on("error", failed);
        source.on("error", failed);
        source.pipe(writer.sink);
      }
    },
    async finish() {
      if (!stdout.sink.writableEnded) stdout.sink.end();
      if (!stderr.sink.writableEnded) stderr.sink.end();
      const outcomes = await Promise.allSettled([
        stdout.completion,
        stderr.completion
      ]);
      for (const outcome of outcomes)
        if (outcome.status === "rejected") recordFailure(outcome.reason);
      await serialize(async () => {
        finished2 = true;
        settled = await capture();
      });
    },
    peek() {
      return serialize(async () => settled ?? await capture());
    },
    checkpoint() {
      if (!settled) throw new Error("exec_snapshot_not_quiescent");
      return settled;
    },
    accept(snapshot) {
      return serialize(async () => {
        if (snapshot.outputFailure)
          throw new Error("exec_output_not_delivered");
        for (const name of ["stdout", "stderr"]) {
          const body = snapshot[name].body;
          const writer = name === "stdout" ? stdout : stderr;
          if (!body || body.startByte !== offsets[name] || body.endByte > writer.byteLength)
            throw new Error("exec_output_snapshot_mismatch");
        }
        offsets.stdout = snapshot.stdout.body.endByte;
        offsets.stderr = snapshot.stderr.body.endByte;
        if (finished2) settled = await capture();
      });
    },
    async dispose() {
      await Promise.all([stdout.dispose(), stderr.dispose()]);
    }
  });
}

// plugins/exec/source/output-store.ts
var import_promises10 = require("node:fs/promises");
var import_node_path5 = require("node:path");

// plugins/exec/source/output-contracts.ts
var DEFAULT_EXEC_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 6e4;
var EXEC_OUTPUT_IO_CHUNK_BYTES = 64 * 1024;

// plugins/exec/source/output-range-reader.ts
var import_node_crypto4 = require("node:crypto");
var import_promises5 = require("node:fs/promises");
function assertOutputRange(startByte, endByte, availableBytes) {
  if (!Number.isSafeInteger(startByte) || startByte < 0)
    throw outputFailure("range_invalid");
  if (!Number.isSafeInteger(endByte) || endByte < startByte)
    throw outputFailure("range_invalid");
  if (endByte > availableBytes) throw outputFailure("range_invalid");
}
async function* readOutputFileRange(path, range) {
  assertOutputRange(
    range.offset,
    range.offset + range.length,
    Number.MAX_SAFE_INTEGER
  );
  if (!Number.isSafeInteger(range.maxChunkBytes) || range.maxChunkBytes < 1 || range.maxChunkBytes > EXEC_OUTPUT_IO_CHUNK_BYTES)
    throw outputFailure("chunk_size_invalid");
  range.signal?.throwIfAborted();
  const handle = await (0, import_promises5.open)(path, "r").catch((error) => {
    throw outputFailure("read_failed", error);
  });
  try {
    const end = range.offset + range.length;
    let position = range.offset;
    while (position < end) {
      range.signal?.throwIfAborted();
      const buffer = Buffer.allocUnsafe(
        Math.min(range.maxChunkBytes, end - position)
      );
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position
      );
      if (bytesRead === 0) throw outputFailure("body_incomplete");
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
    range.signal?.throwIfAborted();
  } catch (error) {
    if (range.signal?.aborted) throw error;
    if (error instanceof ExecPluginError) throw error;
    throw outputFailure("read_failed", error);
  } finally {
    await handle.close();
  }
}
async function hashOutputRange(path, startByte, endByte, signal) {
  const hash = (0, import_node_crypto4.createHash)("sha256");
  for await (const chunk of readOutputFileRange(path, {
    offset: startByte,
    length: endByte - startByte,
    maxChunkBytes: EXEC_OUTPUT_IO_CHUNK_BYTES,
    ...signal ? { signal } : {}
  }))
    hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}
async function assertOutputBodyHash(path, body, signal) {
  assertOutputRange(body.startByte, body.endByte, Number.MAX_SAFE_INTEGER);
  if (body.byteLength !== body.endByte - body.startByte)
    throw outputFailure("snapshot_binding_invalid");
  if (await hashOutputRange(path, body.startByte, body.endByte, signal) !== body.sha256)
    throw outputFailure("body_hash_mismatch");
}

// plugins/exec/source/output-maintenance.ts
var import_promises6 = require("node:fs/promises");
var MAX_CLEANUP_INTERVAL_MS = 60 * 6e4;
var jobs = /* @__PURE__ */ new Map();
function scheduleExecOutputCleanup(root, retentionMs, cleanup) {
  const intervalMs = Math.max(
    1,
    Math.min(retentionMs, MAX_CLEANUP_INTERVAL_MS)
  );
  const previous = jobs.get(root);
  if (previous) {
    previous.cleanup = cleanup;
    previous.intervalMs = intervalMs;
    previous.requested = true;
    return;
  }
  const job = { cleanup, intervalMs, requested: false };
  jobs.set(root, job);
  const sweep = async () => {
    job.requested = false;
    let empty = false;
    try {
      await job.cleanup();
      empty = (await (0, import_promises6.readdir)(root).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })).length === 0;
    } catch {
      process.emitWarning(
        "EXEC output cleanup failed; a later sweep will retry.",
        {
          code: "EXEC_OUTPUT_CLEANUP_FAILED"
        }
      );
    }
    if (empty && !job.requested) {
      jobs.delete(root);
      return;
    }
    const timer = setTimeout(() => {
      void sweep();
    }, job.intervalMs);
    timer.unref();
  };
  void sweep();
}

// plugins/exec/source/output-retention.ts
var import_promises7 = require("node:fs/promises");
var import_node_path4 = require("node:path");
async function outputCaptureCompletedAt(directory, owner) {
  if (owner?.completedAt !== null && owner?.completedAt !== void 0)
    return owner.completedAt;
  const entries = await (0, import_promises7.readdir)(directory, { withFileTypes: true });
  const captures = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".bytes")
  );
  if (!captures.length) return (await (0, import_promises7.stat)(directory)).mtimeMs;
  const times = await Promise.all(
    captures.map(
      async (entry) => (await (0, import_promises7.stat)((0, import_node_path4.join)(directory, entry.name))).mtimeMs
    )
  );
  return Math.max(...times);
}
async function hasOutputExpired(directory, owner, now, retentionMs) {
  return now - await outputCaptureCompletedAt(directory, owner) >= retentionMs;
}

// plugins/exec/source/output-utf8-boundary.ts
function incompleteUtf8TailBytes(tail) {
  if (tail.length === 0) return 0;
  let lead = tail.length - 1;
  while (lead >= 0 && (tail[lead] & 192) === 128) lead -= 1;
  if (lead < 0) return 0;
  const byte = tail[lead];
  let expected = 1;
  if (byte >= 194 && byte <= 223) expected = 2;
  if (byte >= 224 && byte <= 239) expected = 3;
  if (byte >= 240 && byte <= 244) expected = 4;
  const available = tail.length - lead;
  return available < expected ? available : 0;
}

// plugins/exec/source/output-writer.ts
var import_node_crypto5 = require("node:crypto");
var import_promises8 = require("node:fs/promises");
var import_node_stream = require("node:stream");
var import_promises9 = require("node:stream/promises");
var OutputFileSink = class extends import_node_stream.Writable {
  constructor(file) {
    super({ highWaterMark: EXEC_OUTPUT_IO_CHUNK_BYTES });
    this.file = file;
  }
  file;
  committedBytes = 0;
  utf8ByteLength = 0;
  tail = Buffer.alloc(0);
  _write(chunk, _encoding, callback) {
    this.writeChunk(chunk).then(
      () => callback(),
      (error) => callback(outputFailure("write_failed", error))
    );
  }
  async writeChunk(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const length = Math.min(
        EXEC_OUTPUT_IO_CHUNK_BYTES,
        chunk.length - offset
      );
      const { bytesWritten } = await this.file.write(
        chunk,
        offset,
        length,
        this.committedBytes
      );
      if (bytesWritten === 0) throw outputFailure("write_zero_progress");
      const written = chunk.subarray(offset, offset + bytesWritten);
      this.tail = Buffer.concat([this.tail, written.subarray(-4)]).subarray(-4);
      offset += bytesWritten;
      this.committedBytes += bytesWritten;
      this.utf8ByteLength = this.committedBytes - incompleteUtf8TailBytes(this.tail);
    }
  }
  _final(callback) {
    this.file.datasync().then(
      () => callback(),
      (error) => callback(outputFailure("write_failed", error))
    );
  }
  _destroy(error, callback) {
    this.file.close().then(
      () => callback(error),
      (cause) => callback(error ?? outputFailure("close_failed", cause))
    );
  }
};
async function createOutputWriter(params) {
  const streamId = (0, import_node_crypto5.randomUUID)();
  const path = outputStreamPath(params.directory, streamId);
  const file = await (0, import_promises8.open)(path, "wx+", 384).catch((error) => {
    throw outputFailure("write_failed", error);
  });
  const sink = new OutputFileSink(file);
  const completion = (0, import_promises9.finished)(sink).finally(params.onClosed);
  void completion.catch(() => void 0);
  return Object.freeze({
    sink,
    get byteLength() {
      return sink.committedBytes;
    },
    get utf8ByteLength() {
      return sink.utf8ByteLength;
    },
    completion,
    async snapshot(range = {
      startByte: 0
    }) {
      if (sink.errored) throw sink.errored;
      const startByte = range.startByte;
      const endByte = range.endByte ?? sink.committedBytes;
      assertOutputRange(startByte, endByte, sink.committedBytes);
      const body = Object.freeze({
        id: (0, import_node_crypto5.randomUUID)(),
        stream: params.stream,
        startByte,
        endByte,
        byteLength: endByte - startByte,
        sha256: await hashOutputRange(path, startByte, endByte)
      });
      await writeOutputMetadata(outputSnapshotPath(params.directory, body.id), {
        kind: "exec_output_snapshot_v1",
        ownerId: params.ownerId,
        streamId,
        body
      });
      return body;
    },
    async dispose() {
      if (!sink.destroyed) sink.destroy();
      await completion.catch(() => void 0);
    }
  });
}

// plugins/exec/source/output-store.ts
var activeWriters = /* @__PURE__ */ new Map();
var activeReaders = /* @__PURE__ */ new Map();
var ownerOperations = /* @__PURE__ */ new Map();
async function withOutputOwnerLock(directory, operation) {
  const previous = ownerOperations.get(directory) ?? Promise.resolve();
  let release = () => {
  };
  const current = new Promise((resolve2) => {
    release = resolve2;
  });
  ownerOperations.set(directory, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (ownerOperations.get(directory) === current)
      ownerOperations.delete(directory);
  }
}
function createExecOutputStore(params) {
  const root = outputStorageRoot(params.stateDir);
  const retentionMs = params.retentionMs ?? DEFAULT_EXEC_OUTPUT_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0)
    throw outputFailure("retention_invalid");
  const now = params.now ?? Date.now;
  async function retain(directory, ownerId) {
    await prepareOutputOwnerDirectory(directory);
    const previous = await readOutputOwner(directory);
    if (previous && previous.ownerId !== ownerId)
      throw outputFailure("owner_binding_invalid");
    if (previous?.completedAt === null) return;
    await writeOutputMetadata((0, import_node_path5.join)(directory, "owner.json"), {
      kind: "exec_output_owner_v1",
      ownerId,
      completedAt: null
    });
  }
  const store = Object.freeze({
    async createWriter(input) {
      if (input.stream !== "stdout" && input.stream !== "stderr")
        throw outputFailure("stream_invalid");
      const directory = outputOwnerDirectory(root, input.ownerId);
      return withOutputOwnerLock(directory, async () => {
        await retain(directory, input.ownerId);
        const writer = await createOutputWriter({
          directory,
          ownerId: input.ownerId,
          stream: input.stream,
          async onClosed() {
            await withOutputOwnerLock(directory, async () => {
              const count = (activeWriters.get(directory) ?? 1) - 1;
              if (count > 0) activeWriters.set(directory, count);
              if (count > 0) return;
              activeWriters.delete(directory);
              await writeOutputMetadata((0, import_node_path5.join)(directory, "owner.json"), {
                kind: "exec_output_owner_v1",
                ownerId: input.ownerId,
                completedAt: now()
              });
            });
          }
        });
        activeWriters.set(directory, (activeWriters.get(directory) ?? 0) + 1);
        store.startMaintenance();
        return writer;
      });
    },
    async *readRange(input) {
      const directory = outputOwnerDirectory(root, input.ownerId);
      assertOutputRange(
        input.offset,
        input.offset + input.length,
        input.body.byteLength
      );
      await withOutputOwnerLock(directory, async () => {
        const owner = await readOutputOwner(directory);
        if (!owner) throw outputFailure("expired_or_unavailable");
        if (owner.ownerId !== input.ownerId)
          throw outputFailure("owner_binding_invalid");
        if (!activeWriters.has(directory) && await hasOutputExpired(directory, owner, now(), retentionMs))
          throw outputFailure("expired");
        activeReaders.set(directory, (activeReaders.get(directory) ?? 0) + 1);
      });
      try {
        const snapshot = await readOutputSnapshot(
          directory,
          input.ownerId,
          input.body
        );
        const path = outputStreamPath(directory, snapshot.streamId);
        await assertOutputBodyHash(path, input.body, input.signal);
        yield* readOutputFileRange(path, {
          offset: input.body.startByte + input.offset,
          length: input.length,
          maxChunkBytes: input.maxChunkBytes,
          ...input.signal ? { signal: input.signal } : {}
        });
      } finally {
        const count = (activeReaders.get(directory) ?? 1) - 1;
        if (count > 0) activeReaders.set(directory, count);
        if (count === 0) activeReaders.delete(directory);
      }
    },
    startMaintenance() {
      scheduleExecOutputCleanup(
        root,
        retentionMs,
        () => store.cleanupExpired()
      );
    },
    async cleanupExpired() {
      const directories = await (0, import_promises10.readdir)(root, { withFileTypes: true }).catch(
        (error) => {
          if (error.code === "ENOENT") return [];
          throw outputFailure("cleanup_failed", error);
        }
      );
      let removed = 0;
      for (const entry of directories) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name))
          continue;
        const directory = (0, import_node_path5.join)(root, entry.name);
        await withOutputOwnerLock(directory, async () => {
          if (activeWriters.has(directory)) return;
          if (activeReaders.has(directory)) return;
          const owner = await readOutputOwner(directory);
          if (owner && outputOwnerDirectory(root, owner.ownerId) !== directory)
            throw outputFailure("owner_binding_invalid");
          if (!await hasOutputExpired(directory, owner, now(), retentionMs))
            return;
          await (0, import_promises10.rm)(directory, { recursive: true });
          removed += 1;
        });
      }
      return removed;
    }
  });
  return store;
}

// plugins/exec/source/output-snapshot.ts
var import_node_string_decoder = require("node:string_decoder");

// plugins/exec/source/process-output-buffer.ts
var ExecOutputBuffer = class {
  text = "";
  sawOutput = false;
  append(chunk) {
    if (!chunk) return;
    this.sawOutput = true;
    this.text += sanitizeJsonText(chunk);
  }
  peek() {
    const text = this.text;
    return Object.freeze({
      text,
      sawOutput: this.sawOutput,
      metadata: Object.freeze({
        truncated: false,
        originalChars: text.length,
        returnedChars: text.length,
        omittedChars: 0
      })
    });
  }
  accept(snapshot) {
    if (!this.text.startsWith(snapshot.text)) {
      throw new Error("exec_output_snapshot_mismatch");
    }
    this.text = this.text.slice(snapshot.text.length);
  }
  consume() {
    const result = this.peek();
    this.accept(result);
    return result;
  }
};

// plugins/exec/source/output-snapshot.ts
function execOutputOwner(scope, processId) {
  return JSON.stringify([scope, processId]);
}
async function materializeExecOutput(store, scope, snapshot) {
  if (snapshot.outputFailure) return snapshot;
  const ownerId = execOutputOwner(scope, snapshot.processId);
  async function read(stream) {
    if (!stream.body) return stream;
    const decoder = new import_node_string_decoder.StringDecoder("utf8");
    const buffer = new ExecOutputBuffer();
    for await (const chunk of store.readRange({
      ownerId,
      body: stream.body,
      offset: 0,
      length: stream.body.byteLength,
      maxChunkBytes: EXEC_OUTPUT_IO_CHUNK_BYTES
    }))
      buffer.append(decoder.write(Buffer.from(chunk)));
    buffer.append(decoder.end());
    return { ...buffer.peek(), sawOutput: stream.sawOutput, body: stream.body };
  }
  try {
    const stdout = await read(snapshot.stdout);
    const stderr = await read(snapshot.stderr);
    return { ...snapshot, stdout, stderr };
  } catch (error) {
    return {
      ...snapshot,
      outputFailure: {
        code: error instanceof ExecPluginError ? error.code : "exec_output_read_failed",
        stdoutBytes: snapshot.stdout.body?.byteLength ?? 0,
        stderrBytes: snapshot.stderr.body?.byteLength ?? 0
      }
    };
  }
}

// plugins/exec/source/shell-platform.ts
var import_node_fs2 = require("node:fs");
var import_promises11 = require("node:fs/promises");
var import_node_path6 = require("node:path");
var EXEC_SHELL = "/bin/bash";
function execShell(platform = process.platform) {
  if (platform === "win32")
    return import_node_path6.win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
  return EXEC_SHELL;
}
function isSupportedExecPlatform(platform) {
  if (platform === "win32") return true;
  return platform === "linux" || platform === "darwin";
}
async function assertSupportedShell(platform = process.platform) {
  if (!isSupportedExecPlatform(platform)) {
    throw new ExecPluginError(
      "exec_platform_unsupported",
      "The exec plugin requires Linux/macOS with Bash or native Windows with Windows PowerShell."
    );
  }
  try {
    await (0, import_promises11.access)(execShell(platform), import_node_fs2.constants.X_OK);
  } catch {
    throw new ExecPluginError(
      "exec_shell_unavailable",
      `The exec shell is unavailable: ${execShell(platform)}. No command ran. Do not retry until the user restores shell availability.`
    );
  }
}

// plugins/exec/source/shell-process.ts
var import_node_child_process = require("node:child_process");

// plugins/exec/source/windows-shell-bootstrap.ts
var WINDOWS_EXEC_BOOTSTRAP = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Write-Error 'Windows policy blocks the EXEC helper. No command ran. Do not retry or bypass this restriction; ask the user to contact their administrator.' -ErrorAction Continue; exit 126 }",
  "$abotExecOriginalPSModulePath=$env:PSModulePath",
  "try {",
  "$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')",
  "[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)",
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "$OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "$abotExecEnvelope=[Console]::In.ReadToEnd() | ConvertFrom-Json",
  "Add-Type -TypeDefinition $abotExecEnvelope.source",
  "[AbotExecJob]::Attach()",
  "} catch { [Console]::Error.WriteLine('The Windows EXEC helper is unavailable or blocked. No command ran. Do not retry or bypass the restriction; the user must resolve helper availability first.'); exit 126 }",
  "$env:PSModulePath=$abotExecOriginalPSModulePath",
  "$global:LASTEXITCODE=0",
  ". ([ScriptBlock]::Create($abotExecEnvelope.command))",
  "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"
].join(";\n");

// src/shared/windows-job-object.ts
var WINDOWS_EXEC_JOB_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AbotExecJob {
  private static IntPtr job = IntPtr.Zero;

  [StructLayout(LayoutKind.Sequential)]
  private struct BasicLimits {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct ExtendedLimits {
    public BasicLimits BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr handle, int kind,
    ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr handle, IntPtr process);
  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  public static void Attach() {
    if (job != IntPtr.Zero) throw new InvalidOperationException("Already attached");
    IntPtr candidate = CreateJobObject(IntPtr.Zero, null);
    if (candidate == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      ExtendedLimits limits = new ExtendedLimits();
      limits.BasicLimitInformation.LimitFlags = 0x00002000; // KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(candidate, 9, ref limits,
          (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      if (!AssignProcessToJobObject(candidate, GetCurrentProcess()))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      job = candidate;
      candidate = IntPtr.Zero;
    } finally {
      if (candidate != IntPtr.Zero) CloseHandle(candidate);
    }
  }
}
`;

// plugins/exec/source/shell-process.ts
function spawnExecShell(command, cwd) {
  if (process.platform !== "win32")
    return (0, import_node_child_process.spawn)(execShell(), ["-lc", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  const child = (0, import_node_child_process.spawn)(
    execShell(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_EXEC_BOOTSTRAP, "utf16le").toString("base64")
    ],
    { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
  );
  child.stdin.on("error", () => {
  });
  child.stdin.end(
    JSON.stringify({ source: WINDOWS_EXEC_JOB_SOURCE, command }),
    "utf8"
  );
  return child;
}
function killExecProcessTree(child) {
  if (process.platform === "win32") {
    child.kill("SIGKILL");
    return;
  }
  if (typeof child.pid === "number") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
    }
  }
  child.kill("SIGKILL");
}

// plugins/exec/source/process-manager.ts
var MAX_ACTIVE_PROCESSES_PER_SCOPE = 4;
function createExecProcessManager(store = createExecOutputStore({
  stateDir: (0, import_node_path7.join)((0, import_node_os.tmpdir)(), "abot-exec")
})) {
  const processes = /* @__PURE__ */ new Map();
  const opening = /* @__PURE__ */ new Map();
  const unknownProcess = () => new ExecPluginError(
    "unknown_exec_process",
    "The exec process is unknown to this plugin instance and session."
  );
  const dispose = (managed) => {
    processes.delete(managed.processId);
    managed.onDisposed?.(managed.processId);
  };
  const activeProcessCount = (scope) => [...processes.values()].filter(
    (managed) => managed.scope === scope && !managed.settled
  ).length + (opening.get(scope) ?? 0);
  const requestTermination = (managed, reason) => {
    if (managed.settled || managed.terminationReason) return;
    managed.terminationReason = reason;
    killExecProcessTree(managed.child);
    if (reason === "output_storage_failed") {
      managed.child.stdout.destroy();
      managed.child.stderr.destroy();
    }
  };
  const scheduleIdleTimeout = (managed, idleTimeoutMs) => {
    if (managed.settling || managed.settled) return;
    if (managed.idleTimeout) clearTimeout(managed.idleTimeout);
    managed.idleTimeout = setTimeout(
      () => requestTermination(managed, "idle_timeout"),
      idleTimeoutMs
    );
    managed.idleTimeout.unref?.();
  };
  const settle = async (managed, exitCode, fallbackReason) => {
    if (managed.settling || managed.settled) return;
    managed.settling = true;
    if (managed.hardTimeout) clearTimeout(managed.hardTimeout);
    if (managed.idleTimeout) clearTimeout(managed.idleTimeout);
    await managed.output.finish();
    managed.settled = true;
    if (managed.output.checkpoint().outputFailure)
      managed.terminationReason = "output_storage_failed";
    managed.terminationReason ??= fallbackReason;
    managed.exitCode = managed.terminationReason === "hard_timeout" || managed.terminationReason === "idle_timeout" ? 124 : managed.terminationReason === "cancelled" || managed.terminationReason === "aborted" ? 130 : managed.terminationReason === "output_storage_failed" ? -1 : exitCode;
    if (managed.hardTimeout) clearTimeout(managed.hardTimeout);
    if (managed.idleTimeout) clearTimeout(managed.idleTimeout);
    if (managed.abortSignal && managed.abortListener) {
      managed.abortSignal.removeEventListener("abort", managed.abortListener);
    }
    managed.resolveSettled();
    if (managed.terminationReason === "aborted") {
      dispose(managed);
      return;
    }
  };
  const peekSnapshot = async (managed) => {
    managed.terminalDelivery.assertAvailable();
    const status = managed.settled ? "settled" : "running";
    const output = await managed.output.peek();
    if (output.outputFailure && !managed.settled) {
      requestTermination(managed, "output_storage_failed");
      await managed.settlePromise;
      return peekSnapshot(managed);
    }
    const snapshot = await materializeExecOutput(
      store,
      managed.scope,
      Object.freeze({
        processId: managed.processId,
        status,
        nextCursor: managed.cursor,
        ...managed.exitCode === void 0 ? {} : { exitCode: managed.exitCode },
        ...output,
        ...managed.terminationReason ? { terminationReason: managed.terminationReason } : {},
        elapsedMs: Date.now() - managed.startedAt
      })
    );
    if (snapshot.outputFailure && !managed.settled) {
      requestTermination(managed, "output_storage_failed");
      await managed.settlePromise;
      return peekSnapshot(managed);
    }
    return managed.terminalDelivery.reserve(snapshot);
  };
  const waitForSettlement = async (managed, waitMs) => {
    if (managed.settled) return;
    let timeout;
    await Promise.race([
      managed.settlePromise,
      new Promise((resolve2) => {
        timeout = setTimeout(resolve2, waitMs);
        timeout.unref?.();
      })
    ]);
    if (timeout) clearTimeout(timeout);
  };
  const getScopedProcess = (processId, scope) => {
    const managed = processes.get(processId);
    if (!managed || managed.scope !== scope) {
      throw unknownProcess();
    }
    return managed;
  };
  const withProcessTransition = async (managed, operation) => {
    const previous = managed.transitionTail;
    let releaseTransition = () => void 0;
    managed.transitionTail = new Promise((resolve2) => {
      releaseTransition = resolve2;
    });
    await previous;
    try {
      if (processes.get(managed.processId) !== managed) throw unknownProcess();
      return await operation();
    } finally {
      releaseTransition();
    }
  };
  return Object.freeze({
    async start(params) {
      await assertSupportedShell();
      if (activeProcessCount(params.scope) >= MAX_ACTIVE_PROCESSES_PER_SCOPE) {
        throw new ExecPluginError(
          "exec_process_limit_reached",
          `The session already has ${MAX_ACTIVE_PROCESSES_PER_SCOPE} active exec processes.`
        );
      }
      opening.set(params.scope, (opening.get(params.scope) ?? 0) + 1);
      const processId = `exec_${(0, import_node_crypto6.randomUUID)()}`;
      let output;
      try {
        await store.cleanupExpired();
        output = await createExecProcessOutput(
          store,
          execOutputOwner(params.scope, processId)
        );
        if (params.abortSignal?.aborted) {
          await output.dispose();
          params.abortSignal.throwIfAborted();
        }
      } finally {
        const count = opening.get(params.scope) - 1;
        if (count) opening.set(params.scope, count);
        else opening.delete(params.scope);
      }
      let resolveSettled = () => void 0;
      const settlePromise = new Promise((resolve2) => {
        resolveSettled = resolve2;
      });
      let child;
      try {
        child = spawnExecShell(params.shellCommand, params.cwd);
      } catch {
        await output.dispose();
        throw new ExecPluginError(
          "exec_spawn_failed",
          "The runtime could not start the configured non-interactive shell."
        );
      }
      const managed = {
        processId,
        scope: params.scope,
        child,
        startedAt: Date.now(),
        cursor: 1,
        output,
        settling: false,
        settled: false,
        settlePromise,
        resolveSettled,
        transitionTail: Promise.resolve(),
        terminalDelivery: new ExecTerminalDelivery(),
        waitInFlight: false,
        ...params.abortSignal ? { abortSignal: params.abortSignal } : {},
        ...params.onDisposed ? { onDisposed: params.onDisposed } : {}
      };
      processes.set(managed.processId, managed);
      params.onStarted?.(managed.processId, managed.settlePromise);
      output.attach(
        child,
        () => scheduleIdleTimeout(managed, params.idleTimeoutMs),
        () => requestTermination(managed, "output_storage_failed")
      );
      child.on("error", () => {
        void settle(managed, -1, "spawn_failed");
      });
      child.on("close", (code) => {
        void settle(managed, typeof code === "number" ? code : -1, "completed");
      });
      managed.hardTimeout = setTimeout(
        () => requestTermination(managed, "hard_timeout"),
        params.hardTimeoutMs
      );
      managed.hardTimeout.unref?.();
      scheduleIdleTimeout(managed, params.idleTimeoutMs);
      if (params.abortSignal) {
        managed.abortListener = () => requestTermination(managed, "aborted");
        if (params.abortSignal.aborted) managed.abortListener();
        else {
          params.abortSignal.addEventListener("abort", managed.abortListener, {
            once: true
          });
        }
      }
      if (params.yieldAfterMs === null || params.yieldAfterMs >= params.hardTimeoutMs) {
        await managed.settlePromise;
      } else {
        await waitForSettlement(managed, params.yieldAfterMs);
      }
      return peekSnapshot(managed);
    },
    async wait(params) {
      const managed = getScopedProcess(params.processId, params.scope);
      await withProcessTransition(managed, () => {
        managed.terminalDelivery.assertAvailable();
        if (managed.waitInFlight) {
          throw new ExecPluginError(
            "exec_wait_in_progress",
            "Another wait is already observing this exec process."
          );
        }
        if (params.cursor !== managed.cursor) {
          throw new ExecPluginError(
            "stale_exec_process_cursor",
            `The exec cursor is stale; expected ${managed.cursor}.`
          );
        }
        managed.waitInFlight = true;
        if (!managed.settled) managed.cursor += 1;
      });
      await waitForSettlement(managed, params.waitMs);
      return withProcessTransition(managed, () => {
        managed.waitInFlight = false;
        managed.terminalDelivery.assertAvailable();
        return peekSnapshot(managed);
      });
    },
    async cancel(params) {
      const managed = getScopedProcess(params.processId, params.scope);
      return withProcessTransition(managed, async () => {
        managed.terminalDelivery.assertAvailable();
        if (!managed.settled) {
          requestTermination(managed, "cancelled");
          await managed.settlePromise;
        }
        return peekSnapshot(managed);
      });
    },
    snapshotSettled(processId, scope) {
      const managed = getScopedProcess(processId, scope);
      if (!managed.settled || managed.waitInFlight || managed.terminalDelivery.isClaimed)
        throw new Error("exec_snapshot_not_quiescent");
      return Object.freeze({
        cursor: managed.cursor,
        snapshot: Object.freeze({
          processId,
          status: "settled",
          ...managed.exitCode === void 0 ? {} : { exitCode: managed.exitCode },
          ...managed.output.checkpoint(),
          ...managed.terminationReason ? { terminationReason: managed.terminationReason } : {},
          elapsedMs: Date.now() - managed.startedAt
        })
      });
    },
    async accept(snapshot, scope) {
      const wasReleasedAfterAbort = snapshot.terminationReason === "aborted" && !processes.has(snapshot.processId);
      if (wasReleasedAfterAbort) return;
      const managed = getScopedProcess(snapshot.processId, scope);
      await withProcessTransition(managed, async () => {
        managed.terminalDelivery.assertOwner(snapshot);
        if (snapshot.nextCursor !== managed.cursor) {
          throw new ExecPluginError(
            "stale_exec_process_cursor",
            "The output receipt no longer matches the current exec cursor."
          );
        }
        await managed.output.accept(snapshot);
        managed.terminalDelivery.accept(snapshot);
      });
    },
    async reject(snapshot, scope) {
      const managed = processes.get(snapshot.processId);
      if (!managed) return;
      if (managed.scope !== scope) throw unknownProcess();
      await withProcessTransition(managed, () => {
        managed.terminalDelivery.reject(snapshot);
      });
    },
    async release(processId, scope) {
      const managed = processes.get(processId);
      if (!managed) return;
      if (managed.scope !== scope) {
        throw unknownProcess();
      }
      await withProcessTransition(managed, () => {
        if (managed.settled) dispose(managed);
      });
    }
  });
}

// plugins/exec/source/settings.ts
var DEFAULT_EXEC_HARD_TIMEOUT_MS = 6e5;
var DEFAULT_EXEC_YIELD_AFTER_MS = 15e3;
var DEFAULT_EXEC_IDLE_TIMEOUT_MS = 12e4;
var EXEC_COMMAND_MAX_CHARS = 8192;
function readExecSettings(config) {
  return Object.freeze({
    outputRetentionMs: readBoundedInteger(config?.outputRetentionMs, {
      defaultValue: DEFAULT_EXEC_OUTPUT_RETENTION_MS,
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      name: "outputRetentionMs"
    }),
    hardTimeoutMs: readBoundedInteger(config?.timeoutMs, {
      defaultValue: DEFAULT_EXEC_HARD_TIMEOUT_MS,
      minimum: 1,
      maximum: 36e5,
      name: "timeoutMs"
    }),
    yieldAfterMs: readBoundedInteger(config?.yieldAfterMs, {
      defaultValue: DEFAULT_EXEC_YIELD_AFTER_MS,
      minimum: 1,
      maximum: 6e5,
      name: "yieldAfterMs"
    }),
    idleTimeoutMs: readBoundedInteger(config?.idleTimeoutMs, {
      defaultValue: DEFAULT_EXEC_IDLE_TIMEOUT_MS,
      minimum: 1,
      maximum: 36e5,
      name: "idleTimeoutMs"
    })
  });
}

// plugins/exec/source/validation.ts
function isExecutableCommand(value) {
  if (value.trim().length === 0) return false;
  return !value.includes("\0");
}
function readExecCommand(value) {
  const command = readRequiredString(value, {
    name: "command",
    trim: false,
    maxLength: EXEC_COMMAND_MAX_CHARS
  });
  if (!isExecutableCommand(command)) {
    throw new ExecPluginError(
      "exec_command_invalid",
      "The command must contain nonempty text without NUL characters."
    );
  }
  return command;
}
function isInvalidExecParameter(name, value) {
  if (typeof value !== "string") return true;
  if (value.length === 0) return true;
  if (name === "command") return !isExecutableCommand(value);
  return value.includes("\0");
}
function createExecAdapter() {
  return {
    validateCall(input) {
      const invalid2 = ["command", "cwd"].filter(
        (name) => isInvalidExecParameter(name, input.params[name])
      );
      if (invalid2.length === 0) return null;
      return {
        error: `invalid params for exec: invalid ${invalid2.join(", ")}`,
        repairHint: "Provide one command without NUL characters and one explicit existing cwd."
      };
    }
  };
}

// plugins/exec/source/handlers.ts
var COMMAND_PREVIEW_MAX_CHARS = 768;
function processScope(context) {
  const sessionId = context?.sharedState?.currentSessionId?.trim();
  return sessionId || "anonymous";
}
function createExecHandlers(pluginContext, settings, preparation) {
  const outputStore = createExecOutputStore({
    stateDir: pluginContext.stateDir,
    retentionMs: settings.outputRetentionMs
  });
  outputStore.startMaintenance();
  const processManager = createExecProcessManager(outputStore);
  const pendingExecutions = /* @__PURE__ */ new Map();
  const requestResources = new ExecRequestResources(
    processManager,
    pendingExecutions,
    preparation
  );
  const finalizeAndRelease = async (params) => {
    pendingExecutions.set(params.snapshot.processId, params.execution);
    try {
      if (params.snapshot.outputFailure) {
        return retainedOutputFailure(params.snapshot, params.context);
      }
      const result = await finalizeExecResult({
        ...params,
        resultBudget: params.context?.resultBudget
      });
      if (result.errorCode === "plugin_result_too_large") {
        return retainedOutputFailure(params.snapshot, params.context);
      }
      try {
        if (!requestResources.isRestored(params.snapshot.processId)) {
          await processManager.accept(params.snapshot, params.scope);
        }
      } catch (error) {
        return retainedOutputFailure(
          {
            ...params.snapshot,
            outputFailure: {
              code: error instanceof Error ? error.message : "exec_output_acknowledgement_failed",
              stdoutBytes: params.snapshot.stdout.body?.byteLength ?? 0,
              stderrBytes: params.snapshot.stderr.body?.byteLength ?? 0
            }
          },
          params.context
        );
      }
      pendingExecutions.delete(params.snapshot.processId);
      requestResources.forget(params.snapshot.processId);
      await processManager.release(params.snapshot.processId, params.scope);
      return result;
    } finally {
      requestResources.rejectTerminal(params.snapshot);
      await processManager.reject(params.snapshot, params.scope);
    }
  };
  const deliverRunning = async (snapshot, execution, scope, context) => {
    if (snapshot.outputFailure) return retainedOutputFailure(snapshot, context);
    const result = runningResult(snapshot, execution, context?.resultBudget);
    if (result.errorCode === "plugin_result_too_large") {
      return retainedOutputFailure(snapshot, context);
    }
    await processManager.accept(snapshot, scope);
    return result;
  };
  const exec = async (params, context) => {
    try {
      const command = readExecCommand(params.command);
      const cwd = await resolveExecWorkingDirectory(
        pluginContext,
        context,
        params.cwd
      );
      const filesystemStateBefore = await captureExecFilesystemSnapshot(
        cwd.absolutePath,
        cwd.logicalPath
      ).catch(() => null);
      const commandPreview = boundText(command, {
        maxChars: COMMAND_PREVIEW_MAX_CHARS,
        marker: "\n[command preview truncated]"
      }).text;
      const execution = Object.freeze({
        commandPreview,
        cwd,
        filesystemStateBefore,
        hardTimeoutMs: settings.hardTimeoutMs,
        idleTimeoutMs: Math.min(settings.idleTimeoutMs, settings.hardTimeoutMs)
      });
      const scope = processScope(context);
      const snapshot = await processManager.start({
        scope,
        shellCommand: command,
        cwd: cwd.absolutePath,
        yieldAfterMs: Math.min(settings.yieldAfterMs, settings.hardTimeoutMs),
        idleTimeoutMs: execution.idleTimeoutMs,
        hardTimeoutMs: execution.hardTimeoutMs,
        ...context?.abortSignal ? { abortSignal: context.abortSignal } : {},
        onDisposed: (processId) => {
          pendingExecutions.delete(processId);
          requestResources.forget(processId);
        },
        onStarted: (processId, settled) => requestResources.started(processId, scope, settled, context)
      });
      if (snapshot.status === "running") {
        pendingExecutions.set(snapshot.processId, execution);
        return deliverRunning(snapshot, execution, scope, context);
      }
      return finalizeAndRelease({ snapshot, execution, scope, context });
    } catch (error) {
      return execFailureFromError(error, "exec");
    }
  };
  const execWait = async (params, context) => {
    try {
      const processId = readRequiredString(params.process_id, {
        name: "process_id",
        maxLength: 128
      });
      const cursor = readBoundedInteger(params.cursor, {
        name: "cursor",
        minimum: 1,
        maximum: 1e6
      });
      const execution = pendingExecutions.get(processId);
      if (!execution) {
        throw new ExecPluginError(
          "unknown_exec_process",
          "The exec process is unknown to this plugin instance and session."
        );
      }
      const scope = processScope(context);
      const restored = requestResources.terminal(processId, scope, cursor);
      const snapshot = restored ? await materializeExecOutput(outputStore, scope, restored) : await processManager.wait({
        processId,
        scope,
        cursor,
        waitMs: settings.yieldAfterMs
      });
      return snapshot.status === "running" ? deliverRunning(snapshot, execution, scope, context) : finalizeAndRelease({ snapshot, execution, scope, context });
    } catch (error) {
      return execFailureFromError(error, "exec_wait");
    }
  };
  const execCancel = async (params, context) => {
    try {
      const processId = readRequiredString(params.process_id, {
        name: "process_id",
        maxLength: 128
      });
      const execution = pendingExecutions.get(processId);
      if (!execution) {
        throw new ExecPluginError(
          "unknown_exec_process",
          "The exec process is unknown to this plugin instance and session."
        );
      }
      const scope = processScope(context);
      const restored = requestResources.terminal(processId, scope);
      const snapshot = restored ? await materializeExecOutput(outputStore, scope, restored) : await processManager.cancel({ processId, scope });
      return finalizeAndRelease({
        snapshot,
        execution,
        scope,
        cancellationIsSuccess: true,
        context
      });
    } catch (error) {
      return execFailureFromError(error, "exec_cancel");
    }
  };
  return Object.freeze({ exec, exec_wait: execWait, exec_cancel: execCancel });
}

// plugins/exec/source/index.ts
var index_default = defineRuntimePlugin((context) => ({
  handlers: createExecHandlers(context, readExecSettings(context.config)),
  prepareRequest: async (modules, preparation) => {
    if (!preparation?.requestState) return modules;
    const handlers = createExecHandlers(
      context,
      readExecSettings(context.config),
      preparation
    );
    return modules.map((module2) => ({
      ...module2,
      implementation: handlers[module2.definition.name]
    }));
  },
  adapters: {
    exec: createExecAdapter()
  }
}));
