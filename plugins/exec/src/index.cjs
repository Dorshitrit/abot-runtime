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

// plugins/exec/source/filesystem-observer.ts
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var SNAPSHOT_MAX_ENTRIES = 4096;
var SNAPSHOT_MAX_HASHED_BYTES = 16 * 1024 * 1024;
var SNAPSHOT_MAX_HASHED_FILE_BYTES = 2 * 1024 * 1024;
var DELTA_ACTION_LIMIT = 64;
var ACTION_TARGET_MAX_CHARS = 96;
function isMissingPathError(error) {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
function hashBuffer(content) {
  return (0, import_node_crypto.createHash)("sha256").update(content).digest("hex");
}
async function readBoundedDirectory(absoluteDirectory, maxItems) {
  let directory;
  try {
    directory = await (0, import_promises.opendir)(absoluteDirectory);
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
async function inspectRegularFile(absolutePath, remainingHashBytes) {
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
async function captureExecFilesystemSnapshot(absoluteRoot, logicalRoot) {
  const entries = /* @__PURE__ */ new Map();
  let remainingHashBytes = SNAPSHOT_MAX_HASHED_BYTES;
  let complete = true;
  const rootInfo = await (0, import_promises.lstat)(absoluteRoot).catch((error) => {
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
      const info = await (0, import_promises.lstat)(absolutePath).catch((error) => {
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
        const linkTarget = await (0, import_promises.readlink)(absolutePath).catch(() => void 0);
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
        const inspected = await inspectRegularFile(
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

// plugins/exec/source/paths.ts
var import_promises2 = require("node:fs/promises");
var import_node_path2 = require("node:path");
var EXEC_ALLOWED_LOCATIONS = Object.freeze([
  "agent_work",
  "workspace"
]);
function resolverContext(pluginContext, executionContext) {
  return {
    runtimePathResolver: executionContext?.runtimePathResolver ?? pluginContext.runtimePathResolver
  };
}
function resolveExecPath(pluginContext, executionContext, rawPath) {
  return resolvePluginPath(
    resolverContext(pluginContext, executionContext),
    rawPath,
    {
      requirePath: true,
      allowedLocations: EXEC_ALLOWED_LOCATIONS
    }
  );
}
async function resolveExecWorkingDirectory(pluginContext, executionContext, rawPath) {
  const requestedPath = readRequiredString(rawPath, {
    name: "cwd",
    maxLength: 4096
  });
  const target = resolveExecPath(
    pluginContext,
    executionContext,
    requestedPath
  );
  let info;
  try {
    info = await (0, import_promises2.stat)(target.absolutePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ExecPluginError(
        "exec_cwd_not_found",
        "The selected cwd does not exist. Select an existing agent-work or workspace directory."
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
  return target;
}
function resolveExecScopedPath(pluginContext, executionContext, rawPath, cwd) {
  const normalized = rawPath.replaceAll("\\", "/");
  const requested = (0, import_node_path2.isAbsolute)(rawPath) || normalized === "workspace" || normalized.startsWith("workspace/") ? rawPath : import_node_path2.posix.join(cwd.logicalPath, normalized || ".");
  return resolveExecPath(pluginContext, executionContext, requested);
}

// plugins/exec/source/process-manager.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto2 = require("node:crypto");
var import_node_string_decoder = require("node:string_decoder");

// plugins/exec/source/shell-platform.ts
var import_node_fs2 = require("node:fs");
var import_promises3 = require("node:fs/promises");
var EXEC_SHELL = "/bin/bash";
function isSupportedExecPlatform(platform) {
  return platform === "linux" || platform === "darwin";
}
async function assertSupportedShell(platform = process.platform) {
  if (!isSupportedExecPlatform(platform)) {
    throw new ExecPluginError(
      "exec_platform_unsupported",
      "The exec plugin requires Linux or macOS and executable /bin/bash."
    );
  }
  try {
    await (0, import_promises3.access)(EXEC_SHELL, import_node_fs2.constants.X_OK);
  } catch {
    throw new ExecPluginError(
      "exec_shell_unavailable",
      "The exec plugin cannot start because executable /bin/bash is unavailable."
    );
  }
}

// plugins/exec/source/process-manager.ts
var COMPLETED_PROCESS_RETENTION_MS = 5 * 6e4;
var MAX_ACTIVE_PROCESSES_PER_SCOPE = 4;
var CappedTextBuffer = class {
  constructor(maxChars) {
    this.maxChars = maxChars;
  }
  maxChars;
  text = "";
  originalChars = 0;
  omittedChars = 0;
  sawOutput = false;
  append(chunk) {
    if (!chunk) return;
    const safeChunk = sanitizeJsonText(chunk);
    this.sawOutput = true;
    this.originalChars += safeChunk.length;
    const available = Math.max(this.maxChars - this.text.length, 0);
    this.text += safeChunk.slice(0, available);
    this.omittedChars += Math.max(safeChunk.length - available, 0);
  }
  consume() {
    const text = this.text;
    const originalChars = this.originalChars;
    const omittedChars = this.omittedChars;
    this.text = "";
    this.originalChars = 0;
    this.omittedChars = 0;
    return Object.freeze({
      text,
      sawOutput: this.sawOutput,
      metadata: Object.freeze({
        truncated: omittedChars > 0,
        originalChars,
        returnedChars: text.length,
        omittedChars
      })
    });
  }
};
function createExecProcessManager() {
  const processes = /* @__PURE__ */ new Map();
  const unknownProcess = () => new ExecPluginError(
    "unknown_exec_process",
    "The exec process is unknown to this plugin instance and session."
  );
  const dispose = (managed) => {
    if (managed.retentionTimeout) clearTimeout(managed.retentionTimeout);
    processes.delete(managed.processId);
    managed.onDisposed?.(managed.processId);
  };
  const activeProcessCount = (scope) => [...processes.values()].filter(
    (managed) => managed.scope === scope && !managed.settled
  ).length;
  const killProcessTree = (managed) => {
    const pid = managed.child.pid;
    if (typeof pid === "number") {
      try {
        process.kill(-pid, "SIGKILL");
        return;
      } catch {
      }
    }
    managed.child.kill("SIGKILL");
  };
  const requestTermination = (managed, reason) => {
    if (managed.settled || managed.terminationReason) return;
    managed.terminationReason = reason;
    killProcessTree(managed);
  };
  const scheduleIdleTimeout = (managed, idleTimeoutMs) => {
    if (managed.idleTimeout) clearTimeout(managed.idleTimeout);
    managed.idleTimeout = setTimeout(
      () => requestTermination(managed, "idle_timeout"),
      idleTimeoutMs
    );
    managed.idleTimeout.unref?.();
  };
  const settle = (managed, exitCode, fallbackReason) => {
    if (managed.settled) return;
    managed.settled = true;
    managed.terminationReason ??= fallbackReason;
    managed.exitCode = managed.terminationReason === "hard_timeout" || managed.terminationReason === "idle_timeout" ? 124 : managed.terminationReason === "cancelled" || managed.terminationReason === "aborted" ? 130 : exitCode;
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
    managed.retentionTimeout = setTimeout(
      () => dispose(managed),
      COMPLETED_PROCESS_RETENTION_MS
    );
    managed.retentionTimeout.unref?.();
  };
  const consumeSnapshot = (managed) => {
    if (managed.settled) {
      if (managed.terminalSnapshotClaimed) throw unknownProcess();
      managed.terminalSnapshotClaimed = true;
    }
    return Object.freeze({
      processId: managed.processId,
      status: managed.settled ? "settled" : "running",
      ...!managed.settled ? { nextCursor: managed.cursor } : {},
      ...managed.exitCode === void 0 ? {} : { exitCode: managed.exitCode },
      stdout: managed.stdout.consume(),
      stderr: managed.stderr.consume(),
      ...managed.terminationReason ? { terminationReason: managed.terminationReason } : {},
      elapsedMs: Date.now() - managed.startedAt
    });
  };
  const waitForSettlement = async (managed, waitMs) => {
    if (managed.settled) return;
    let timeout;
    await Promise.race([
      managed.settlePromise,
      new Promise((resolve) => {
        timeout = setTimeout(resolve, waitMs);
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
    managed.transitionTail = new Promise((resolve) => {
      releaseTransition = resolve;
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
      let resolveSettled = () => void 0;
      const settlePromise = new Promise((resolve) => {
        resolveSettled = resolve;
      });
      let child;
      try {
        child = (0, import_node_child_process.spawn)(EXEC_SHELL, ["-lc", params.shellCommand], {
          cwd: params.cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch {
        throw new ExecPluginError(
          "exec_spawn_failed",
          "The runtime could not start the configured non-interactive shell."
        );
      }
      const managed = {
        processId: `exec_${(0, import_node_crypto2.randomUUID)()}`,
        scope: params.scope,
        child,
        startedAt: Date.now(),
        cursor: 1,
        stdout: new CappedTextBuffer(params.outputMaxChars),
        stderr: new CappedTextBuffer(params.outputMaxChars),
        stdoutDecoder: new import_node_string_decoder.StringDecoder("utf8"),
        stderrDecoder: new import_node_string_decoder.StringDecoder("utf8"),
        settled: false,
        settlePromise,
        resolveSettled,
        transitionTail: Promise.resolve(),
        terminalSnapshotClaimed: false,
        waitInFlight: false,
        ...params.abortSignal ? { abortSignal: params.abortSignal } : {},
        ...params.onDisposed ? { onDisposed: params.onDisposed } : {}
      };
      processes.set(managed.processId, managed);
      const observe = (stream, chunk) => {
        if (managed.settled || !chunk) return;
        if (stream === "stdout") managed.stdout.append(chunk);
        else managed.stderr.append(chunk);
        scheduleIdleTimeout(managed, params.idleTimeoutMs);
      };
      child.stdout.on(
        "data",
        (chunk) => observe("stdout", managed.stdoutDecoder.write(chunk))
      );
      child.stderr.on(
        "data",
        (chunk) => observe("stderr", managed.stderrDecoder.write(chunk))
      );
      child.on("error", () => settle(managed, -1, "spawn_failed"));
      child.on("close", (code) => {
        observe("stdout", managed.stdoutDecoder.end());
        observe("stderr", managed.stderrDecoder.end());
        settle(managed, typeof code === "number" ? code : -1, "completed");
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
      return consumeSnapshot(managed);
    },
    async wait(params) {
      const managed = getScopedProcess(params.processId, params.scope);
      await withProcessTransition(managed, () => {
        if (managed.terminalSnapshotClaimed) throw unknownProcess();
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
        if (managed.terminalSnapshotClaimed) throw unknownProcess();
        return consumeSnapshot(managed);
      });
    },
    async cancel(params) {
      const managed = getScopedProcess(params.processId, params.scope);
      return withProcessTransition(managed, async () => {
        if (managed.terminalSnapshotClaimed) throw unknownProcess();
        if (!managed.settled) {
          requestTermination(managed, "cancelled");
          await managed.settlePromise;
        }
        return consumeSnapshot(managed);
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
var DEFAULT_EXEC_OUTPUT_MAX_CHARS = 8e3;
var EXEC_OUTPUT_MAX_CHARS = 8e3;
var EXEC_COMMAND_MAX_CHARS = 4096;
function readExecSettings(config) {
  return Object.freeze({
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
    }),
    outputMaxChars: readBoundedInteger(config?.outputMaxChars, {
      defaultValue: DEFAULT_EXEC_OUTPUT_MAX_CHARS,
      minimum: 64,
      maximum: EXEC_OUTPUT_MAX_CHARS,
      name: "outputMaxChars"
    })
  });
}

// plugins/exec/source/validation.ts
var INVALID_COMMAND_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/gu;
var INTERACTIVE_COMMANDS = /* @__PURE__ */ new Set([
  "gio",
  "gnome-open",
  "htop",
  "kde-open",
  "less",
  "more",
  "nano",
  "open",
  "screen",
  "ssh",
  "start",
  "tmux",
  "top",
  "vi",
  "vim",
  "watch",
  "xdg-open"
]);
function sanitizeExecCommand(value) {
  const raw = value.trim();
  const command = raw.replace(/\r\n?/gu, "\n").replace(INVALID_COMMAND_CHARS, "").trim();
  return Object.freeze({ command, normalized: command !== raw });
}
function isInteractiveCommand(command) {
  const firstToken = command.split(/\s+/u)[0]?.toLowerCase() ?? "";
  return INTERACTIVE_COMMANDS.has(firstToken) ? firstToken : void 0;
}
function isWhitespace(char) {
  return char === " " || char === "	" || char === "\r";
}
function isShellSeparator(char) {
  return ["\n", ";", "|", "&", "<", ">"].includes(char);
}
function isShellTokenBoundary(char) {
  return isWhitespace(char) || isShellSeparator(char) || char === "(" || char === ")";
}
function readShellTokenSpan(command, start) {
  let index = start;
  let token = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let substitutionDepth = 0;
  while (index < command.length) {
    const char = command[index] ?? "";
    if (!inSingleQuote && !inDoubleQuote) {
      if (substitutionDepth === 0 && isShellTokenBoundary(char)) break;
      if (char === "$" && command[index + 1] === "(") {
        token += "$(";
        substitutionDepth += 1;
        index += 2;
        continue;
      }
      if (char === ")" && substitutionDepth > 0) {
        token += char;
        substitutionDepth -= 1;
        index += 1;
        continue;
      }
      if (char === "\\") {
        index += 1;
        if (index < command.length) {
          token += command[index];
          index += 1;
        }
        continue;
      }
      if (char === "'") {
        inSingleQuote = true;
        index += 1;
        continue;
      }
      if (char === '"') {
        inDoubleQuote = true;
        index += 1;
        continue;
      }
      token += char;
      index += 1;
      continue;
    }
    index += 1;
    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false;
      else token += char;
      continue;
    }
    if (char === '"') {
      inDoubleQuote = false;
      continue;
    }
    if (char === "\\" && index < command.length) {
      token += command[index];
      index += 1;
      continue;
    }
    token += char;
  }
  return Object.freeze({ token: token.trim(), nextIndex: index });
}
function readShellToken(command, start) {
  let index = start;
  while (index < command.length && isWhitespace(command[index] ?? "")) {
    index += 1;
  }
  return readShellTokenSpan(command, index);
}
function readHereDocDelimiters(line) {
  const delimiters = [];
  const pattern = /<<(-)?\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_./-]+))/gu;
  for (const match of line.matchAll(pattern)) {
    const delimiter = match[2] ?? match[3] ?? match[4] ?? "";
    if (delimiter) {
      delimiters.push({ delimiter, stripTabs: Boolean(match[1]) });
    }
  }
  return delimiters;
}
function stripHereDocBodies(command) {
  const pending = [];
  return command.split("\n").map((line) => {
    const active = pending[0];
    if (active) {
      const comparable = active.stripTabs ? line.replace(/^\t+/u, "") : line;
      if (comparable === active.delimiter) {
        pending.shift();
        return line;
      }
      return "";
    }
    pending.push(...readHereDocDelimiters(line));
    return line;
  }).join("\n");
}
function scopedPathTokens(command) {
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    while (index < command.length && isShellTokenBoundary(command[index] ?? "")) {
      index += 1;
    }
    if (index >= command.length) break;
    const span = readShellToken(command, index);
    index = Math.max(span.nextIndex, index + 1);
    const token = span.token;
    if (token === "." || token === ".." || token.startsWith("./") || token.startsWith("../") || token === "workspace" || token.startsWith("workspace/") || token.startsWith("workspace\\") || token.startsWith("/")) {
      tokens.push(token);
    }
  }
  return Object.freeze(tokens);
}
function createExecAdapter() {
  return {
    validateCall(input) {
      const invalid = ["command", "cwd"].filter((name) => {
        const value = input.params[name];
        return typeof value !== "string" || value.trim().length === 0;
      });
      if (invalid.length === 0) return null;
      return {
        error: `invalid params for exec: invalid ${invalid.join(", ")}`,
        repairHint: "Provide one non-interactive command and one explicit existing agent-work or workspace cwd."
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
function streamDisplay(snapshot) {
  if (snapshot.text) return snapshot.text;
  return snapshot.sawOutput ? "(no new output; earlier output was already returned)" : "(empty)";
}
function renderedOutput(lines, outputMaxChars) {
  const bounded = boundText(lines.join("\n"), {
    maxChars: outputMaxChars,
    marker: "\n[exec output truncated]"
  });
  return Object.freeze({ output: bounded.text, metadata: bounded.metadata });
}
function outputBoundsData(snapshot, rendered, maxChars) {
  return Object.freeze({
    maxChars,
    stdout: snapshot.stdout.metadata,
    stderr: snapshot.stderr.metadata,
    rendered
  });
}
function runningResult(snapshot, execution) {
  const nextCursor = snapshot.nextCursor ?? 1;
  const rendered = renderedOutput(
    [
      `Command: ${execution.commandPreview}`,
      ...execution.commandWasNormalized ? ["Command normalization: invalid control characters were removed."] : [],
      `CWD: ${execution.cwd.logicalPath}`,
      "Process status: running",
      `Process ID: ${snapshot.processId}`,
      `Next cursor: ${nextCursor}`,
      "STDOUT since the previous observation:",
      streamDisplay(snapshot.stdout),
      "STDERR since the previous observation:",
      streamDisplay(snapshot.stderr),
      "Continue this exact process with exec_wait; do not run the command again."
    ],
    execution.outputMaxChars
  );
  return failureResult({
    errorCode: "exec_process_running",
    message: "The command is still running. Continue it with exec_wait using the returned process ID and cursor.",
    output: rendered.output,
    stdout: snapshot.stdout.text,
    stderr: snapshot.stderr.text,
    data: {
      processId: snapshot.processId,
      processStatus: "running",
      nextCursor,
      outputBounds: outputBoundsData(
        snapshot,
        rendered.metadata,
        execution.outputMaxChars
      ),
      observationMeta: {
        kind: "volatile_external",
        carryPolicy: "never"
      }
    }
  });
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
      ...execution.commandWasNormalized ? ["Command normalization: invalid control characters were removed."] : [],
      `CWD: ${execution.cwd.logicalPath}`,
      `Process ID: ${snapshot.processId}`,
      `Process status: ${snapshot.terminationReason ?? "completed"}`,
      `Exit code: ${exitCode}`,
      ...filesystemEvidence ? filesystemEvidence.outputLines : [],
      "STDOUT:",
      streamDisplay(snapshot.stdout),
      "STDERR:",
      streamDisplay(snapshot.stderr),
      ...resultSummary ? [resultSummary] : []
    ],
    execution.outputMaxChars
  );
  const processStatus = snapshot.terminationReason ?? "completed";
  const data = {
    ...commandHasData ? { hasData: true } : {},
    ...observedStateChange ? { mutationEvidence: true } : {},
    ...filesystemEvidence ? { mutationGrounding: filesystemEvidence.mutationGrounding } : {},
    processId: snapshot.processId,
    processStatus,
    outputBounds: outputBoundsData(
      snapshot,
      rendered.metadata,
      execution.outputMaxChars
    ),
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
    return enforcePluginResultByteBudget({ ok: true, ...common });
  }
  const errorCode = inconclusiveSuccess ? "no_observable_result" : snapshot.terminationReason === "aborted" ? "exec_aborted" : snapshot.terminationReason === "spawn_failed" ? "exec_spawn_failed" : snapshot.terminationReason === "idle_timeout" ? "exec_idle_timeout" : snapshot.terminationReason === "hard_timeout" ? "exec_hard_timeout" : "non_zero_exit";
  const error = inconclusiveSuccess ? resultSummary : errorCode === "exec_aborted" ? "The exec request was aborted." : errorCode === "exec_spawn_failed" ? "The runtime could not start the configured non-interactive shell." : errorCode === "exec_idle_timeout" ? `The command produced no output for ${execution.idleTimeoutMs}ms.` : errorCode === "exec_hard_timeout" ? `The command exceeded the ${execution.hardTimeoutMs}ms hard timeout.` : `The command exited with code ${exitCode}.`;
  return enforcePluginResultByteBudget({
    ok: false,
    ...common,
    error,
    errorCode
  });
}
function createExecHandlers(pluginContext, settings) {
  const processManager = createExecProcessManager();
  const pendingExecutions = /* @__PURE__ */ new Map();
  const finalizeAndRelease = async (params) => {
    try {
      return await finalizeExecResult(params);
    } finally {
      pendingExecutions.delete(params.snapshot.processId);
      await processManager.release(params.snapshot.processId, params.scope);
    }
  };
  const exec = async (params, context) => {
    try {
      const rawCommand = readRequiredString(params.command, {
        name: "command",
        trim: false,
        maxLength: EXEC_COMMAND_MAX_CHARS
      });
      const { command, normalized } = sanitizeExecCommand(rawCommand);
      if (!command) {
        throw new ExecPluginError(
          "exec_command_invalid",
          "The command is empty after invalid control characters are removed."
        );
      }
      const interactive = isInteractiveCommand(command);
      if (interactive) {
        throw new ExecPluginError(
          "exec_interactive_command_blocked",
          `Interactive command ${interactive} is not supported by the non-interactive exec plugin.`
        );
      }
      const cwd = await resolveExecWorkingDirectory(
        pluginContext,
        context,
        params.cwd
      );
      const staticCommand = stripHereDocBodies(command);
      for (const token of scopedPathTokens(staticCommand)) {
        resolveExecScopedPath(pluginContext, context, token, cwd);
      }
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
        commandWasNormalized: normalized,
        cwd,
        filesystemStateBefore,
        hardTimeoutMs: settings.hardTimeoutMs,
        idleTimeoutMs: Math.min(settings.idleTimeoutMs, settings.hardTimeoutMs),
        outputMaxChars: settings.outputMaxChars
      });
      const scope = processScope(context);
      const snapshot = await processManager.start({
        scope,
        shellCommand: command,
        cwd: cwd.absolutePath,
        outputMaxChars: settings.outputMaxChars,
        yieldAfterMs: Math.min(settings.yieldAfterMs, settings.hardTimeoutMs),
        idleTimeoutMs: execution.idleTimeoutMs,
        hardTimeoutMs: execution.hardTimeoutMs,
        ...context?.abortSignal ? { abortSignal: context.abortSignal } : {},
        onDisposed: (processId) => pendingExecutions.delete(processId)
      });
      if (snapshot.status === "running") {
        pendingExecutions.set(snapshot.processId, execution);
        return runningResult(snapshot, execution);
      }
      return finalizeAndRelease({ snapshot, execution, scope });
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
      const snapshot = await processManager.wait({
        processId,
        scope,
        cursor,
        waitMs: settings.yieldAfterMs
      });
      return snapshot.status === "running" ? runningResult(snapshot, execution) : finalizeAndRelease({ snapshot, execution, scope });
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
      const snapshot = await processManager.cancel({ processId, scope });
      return finalizeAndRelease({
        snapshot,
        execution,
        scope,
        cancellationIsSuccess: true
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
  adapters: {
    exec: createExecAdapter()
  }
}));
