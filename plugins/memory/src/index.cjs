// GENERATED FILE - DO NOT EDIT.
// Source: plugins/memory/source/index.ts
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

// plugins/memory/source/index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var import_node_path3 = require("node:path");

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

// plugins/memory/source/format.ts
var OUTPUT_MAX_CHARS = 2e4;
function renderEntries(entries, options) {
  const lines = [options.heading];
  let returnedEntries = 0;
  for (const entry of entries) {
    const next = [
      `${returnedEntries + 1}. [${entry.id}] ${entry.content}`,
      `   createdAt: ${entry.createdAt}`
    ];
    const candidate = [...lines, ...next].join("\n");
    if (candidate.length > OUTPUT_MAX_CHARS) break;
    lines.push(...next);
    returnedEntries += 1;
  }
  if (returnedEntries === 0 && entries.length === 0)
    lines.push("No entries found.");
  let truncated = returnedEntries < entries.length || returnedEntries < options.totalEntries;
  while (truncated) {
    const marker = `[memory output bounded; ${Math.max(options.totalEntries - returnedEntries, 0)} entry or entries remain]`;
    if ([...lines, marker].join("\n").length <= OUTPUT_MAX_CHARS) {
      lines.push(marker);
      break;
    }
    if (returnedEntries === 0) {
      lines.length = 1;
      lines.push(marker.slice(0, OUTPUT_MAX_CHARS - lines[0].length - 1));
      break;
    }
    lines.splice(-2, 2);
    returnedEntries -= 1;
    truncated = true;
  }
  return Object.freeze({
    output: lines.join("\n"),
    returnedEntries,
    truncated,
    outputMaxChars: OUTPUT_MAX_CHARS
  });
}

// plugins/memory/source/search.ts
function normalize(value) {
  return value.toLowerCase().trim();
}
function terms(value) {
  return Object.freeze([
    ...new Set(
      (normalize(value).match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (term) => term.length >= 2
      )
    )
  ]);
}
function score(query, content) {
  const normalizedContent = normalize(content);
  const normalizedQuery = normalize(query);
  if (normalizedQuery && normalizedContent.includes(normalizedQuery))
    return 100;
  return terms(query).reduce(
    (total, term) => normalizedContent.includes(term) ? total + 20 + term.length : total,
    0
  );
}
function searchMemory(entries, query, maximum) {
  const ranked = entries.map((entry) => ({ entry, score: score(query, entry.content) })).filter(({ score: score2 }) => score2 > 0).sort(
    (left, right) => right.score - left.score || left.entry.createdAt.localeCompare(right.entry.createdAt) || left.entry.id.localeCompare(right.entry.id)
  );
  return Object.freeze({
    matches: Object.freeze(ranked.slice(0, maximum).map(({ entry }) => entry)),
    totalMatches: ranked.length
  });
}

// plugins/memory/source/store.ts
var import_node_crypto2 = require("node:crypto");
var import_promises2 = require("node:fs/promises");
var import_node_path2 = require("node:path");

// plugins/memory/source/types.ts
var MemoryStoreError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "MemoryStoreError";
    this.code = code;
  }
};
function isMemoryStoreError(error) {
  return error instanceof MemoryStoreError;
}

// plugins/memory/source/store-lock.ts
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
var DEFAULT_WAIT_MS = 1e4;
var DEFAULT_RETRY_MS = 10;
var MAX_LOCK_BYTES = 1024;
var INCOMPLETE_LOCK_GRACE_MS = 1e3;
var LEASE_DIRECTORY_NAME = "lease";
var OWNER_FILE_PATTERN = /^owner-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/iu;
function fileSystemErrorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : void 0;
}
function defaultProcessIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fileSystemErrorCode(error) !== "ESRCH";
  }
}
function ownerFileName(token) {
  return `owner-${token}.json`;
}
function parseLockContents(raw, expectedToken) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return Object.freeze({});
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({});
  }
  const record = value;
  const ownerPid = Number.isSafeInteger(record.pid) && Number(record.pid) > 0 ? Number(record.pid) : void 0;
  if (ownerPid === void 0 || record.token !== expectedToken || typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) {
    return Object.freeze({ ...ownerPid === void 0 ? {} : { ownerPid } });
  }
  return Object.freeze({
    ownerPid,
    record: Object.freeze({
      pid: ownerPid,
      token: expectedToken,
      createdAt: record.createdAt
    })
  });
}
async function readOwnerRecord(lockPath, entryName, expectedToken, directoryModifiedAtMs) {
  let handle;
  try {
    handle = await (0, import_promises.open)(
      (0, import_node_path.join)(lockPath, LEASE_DIRECTORY_NAME, entryName),
      import_node_fs.constants.O_RDONLY | import_node_fs.constants.O_NOFOLLOW
    );
    const info = await handle.stat({ bigint: true });
    const modifiedAtMs = Math.max(directoryModifiedAtMs, Number(info.mtimeMs));
    if (!info.isFile() || info.size <= 0n || info.size > BigInt(MAX_LOCK_BYTES)) {
      return Object.freeze({
        kind: "directory",
        modifiedAtMs,
        hasLeaseDirectory: true,
        ownerFileName: entryName,
        reclaimable: true
      });
    }
    const bytes = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset
      );
      if (result.bytesRead <= 0) {
        return Object.freeze({
          kind: "directory",
          modifiedAtMs,
          hasLeaseDirectory: true,
          ownerFileName: entryName,
          reclaimable: false
        });
      }
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) {
      return Object.freeze({
        kind: "directory",
        modifiedAtMs,
        hasLeaseDirectory: true,
        ownerFileName: entryName,
        reclaimable: false
      });
    }
    const parsed = parseLockContents(bytes.toString("utf8"), expectedToken);
    return Object.freeze({
      kind: "directory",
      modifiedAtMs,
      hasLeaseDirectory: true,
      ownerFileName: entryName,
      reclaimable: true,
      ...parsed
    });
  } catch (error) {
    const code = fileSystemErrorCode(error);
    if (code === "ENOENT") {
      return Object.freeze({
        kind: "directory",
        modifiedAtMs: directoryModifiedAtMs,
        hasLeaseDirectory: true,
        reclaimable: false
      });
    }
    if (code === "ELOOP") {
      return Object.freeze({
        kind: "directory",
        modifiedAtMs: directoryModifiedAtMs,
        hasLeaseDirectory: true,
        ownerFileName: entryName,
        reclaimable: true
      });
    }
    throw error;
  } finally {
    await handle?.close().catch(() => void 0);
  }
}
async function readLockSnapshot(lockPath) {
  let lockInfo;
  try {
    lockInfo = await (0, import_promises.lstat)(lockPath);
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return void 0;
    throw error;
  }
  if (!lockInfo.isDirectory()) {
    return Object.freeze({ kind: "legacy" });
  }
  let entries;
  try {
    entries = await (0, import_promises.readdir)(lockPath, { withFileTypes: true });
  } catch (error) {
    const code = fileSystemErrorCode(error);
    if (code === "ENOENT") return void 0;
    if (code === "ENOTDIR") return Object.freeze({ kind: "legacy" });
    throw error;
  }
  if (entries.length === 0) {
    return Object.freeze({
      kind: "directory",
      modifiedAtMs: lockInfo.mtimeMs,
      hasLeaseDirectory: false,
      reclaimable: true
    });
  }
  if (entries.length !== 1 || entries[0]?.name !== LEASE_DIRECTORY_NAME || !entries[0].isDirectory()) {
    return Object.freeze({
      kind: "directory",
      modifiedAtMs: lockInfo.mtimeMs,
      hasLeaseDirectory: false,
      reclaimable: false
    });
  }
  const leasePath = (0, import_node_path.join)(lockPath, LEASE_DIRECTORY_NAME);
  let leaseInfo;
  let leaseEntries;
  try {
    leaseInfo = await (0, import_promises.lstat)(leasePath);
    if (!leaseInfo.isDirectory()) {
      return Object.freeze({
        kind: "directory",
        modifiedAtMs: lockInfo.mtimeMs,
        hasLeaseDirectory: false,
        reclaimable: false
      });
    }
    leaseEntries = await (0, import_promises.readdir)(leasePath, { withFileTypes: true });
  } catch (error) {
    const code = fileSystemErrorCode(error);
    if (code === "ENOENT") {
      return Object.freeze({
        kind: "directory",
        modifiedAtMs: lockInfo.mtimeMs,
        hasLeaseDirectory: false,
        reclaimable: false
      });
    }
    throw error;
  }
  const modifiedAtMs = Math.max(lockInfo.mtimeMs, leaseInfo.mtimeMs);
  if (leaseEntries.length === 0) {
    return Object.freeze({
      kind: "directory",
      modifiedAtMs,
      hasLeaseDirectory: true,
      reclaimable: true
    });
  }
  if (leaseEntries.length !== 1 || !leaseEntries[0]?.isFile()) {
    return Object.freeze({
      kind: "directory",
      modifiedAtMs,
      hasLeaseDirectory: true,
      reclaimable: false
    });
  }
  const entryName = leaseEntries[0].name;
  const token = OWNER_FILE_PATTERN.exec(entryName)?.[1];
  if (!token) {
    return Object.freeze({
      kind: "directory",
      modifiedAtMs,
      hasLeaseDirectory: true,
      reclaimable: false
    });
  }
  return readOwnerRecord(lockPath, entryName, token, modifiedAtMs);
}
async function removeDirectoryIfEmpty(path) {
  try {
    await (0, import_promises.rmdir)(path);
    return true;
  } catch (error) {
    const code = fileSystemErrorCode(error);
    if (code === "ENOENT") return true;
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}
async function removeEmptyLockTree(lockPath, hasLeaseDirectory) {
  if (hasLeaseDirectory && !await removeDirectoryIfEmpty((0, import_node_path.join)(lockPath, LEASE_DIRECTORY_NAME))) {
    return false;
  }
  return removeDirectoryIfEmpty(lockPath);
}
async function removeObservedOwner(lockPath, observedOwnerFileName) {
  try {
    await (0, import_promises.unlink)((0, import_node_path.join)(lockPath, LEASE_DIRECTORY_NAME, observedOwnerFileName));
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return false;
    throw error;
  }
  return removeEmptyLockTree(lockPath, true);
}
async function removeAbandonedLock(lockPath, processIsAlive) {
  const snapshot = await readLockSnapshot(lockPath);
  if (!snapshot) return true;
  if (snapshot.kind === "legacy" || !snapshot.reclaimable) return false;
  if (snapshot.ownerPid !== void 0 && processIsAlive(snapshot.ownerPid)) {
    return false;
  }
  if (snapshot.record && snapshot.ownerFileName) {
    return removeObservedOwner(lockPath, snapshot.ownerFileName);
  }
  if (Date.now() - snapshot.modifiedAtMs < INCOMPLETE_LOCK_GRACE_MS) {
    return false;
  }
  if (snapshot.ownerFileName) {
    return removeObservedOwner(lockPath, snapshot.ownerFileName);
  }
  return removeEmptyLockTree(lockPath, snapshot.hasLeaseDirectory);
}
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function isLockConflict(error) {
  const code = fileSystemErrorCode(error);
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR" || code === "EISDIR";
}
async function removeStagingLock(stagingPath, stagingOwnerPath) {
  try {
    await (0, import_promises.unlink)(stagingOwnerPath);
  } catch (error) {
    if (fileSystemErrorCode(error) !== "ENOENT") throw error;
  }
  try {
    await (0, import_promises.rmdir)(stagingPath);
  } catch (error) {
    if (fileSystemErrorCode(error) !== "ENOENT") throw error;
  }
}
async function installLockDirectory(lockPath, token) {
  const stagingPath = `${lockPath}.${process.pid}.${token}.pending`;
  const stagingOwnerPath = (0, import_node_path.join)(stagingPath, ownerFileName(token));
  let handle;
  let installed = false;
  let claimedLockPath = false;
  try {
    await (0, import_promises.mkdir)(stagingPath, { mode: 448 });
    handle = await (0, import_promises.open)(stagingOwnerPath, "wx", 384);
    await handle.writeFile(
      JSON.stringify({
        pid: process.pid,
        token,
        createdAt: (/* @__PURE__ */ new Date()).toISOString()
      }),
      "utf8"
    );
    await handle.sync();
    await handle.close();
    handle = void 0;
    await (0, import_promises.mkdir)(lockPath, { mode: 448 });
    claimedLockPath = true;
    await (0, import_promises.rename)(stagingPath, (0, import_node_path.join)(lockPath, LEASE_DIRECTORY_NAME));
    installed = true;
  } finally {
    await handle?.close().catch(() => void 0);
    if (!installed) {
      await removeStagingLock(stagingPath, stagingOwnerPath);
      if (claimedLockPath) {
        await removeDirectoryIfEmpty(lockPath);
      }
    }
  }
}
async function acquireStoreLock(filePath, options = {}) {
  const lockPath = `${filePath}.lock`;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
  const processIsAlive = options.processIsAlive ?? defaultProcessIsAlive;
  const deadline = Date.now() + waitMs;
  await (0, import_promises.mkdir)((0, import_node_path.dirname)(filePath), { recursive: true });
  while (true) {
    const token = (0, import_node_crypto.randomUUID)();
    try {
      await installLockDirectory(lockPath, token);
      let released = false;
      return async () => {
        if (released) return;
        await removeObservedOwner(lockPath, ownerFileName(token));
        released = true;
      };
    } catch (error) {
      if (!isLockConflict(error)) {
        throw new MemoryStoreError(
          "memory_store_unavailable",
          "Memory store is unavailable."
        );
      }
      let removed = false;
      try {
        removed = await removeAbandonedLock(lockPath, processIsAlive);
      } catch {
        throw new MemoryStoreError(
          "memory_store_unavailable",
          "Memory store is unavailable."
        );
      }
      if (removed) continue;
      if (Date.now() >= deadline) {
        throw new MemoryStoreError(
          "memory_store_busy",
          "Memory store is busy."
        );
      }
      await delay(Math.min(retryMs, Math.max(deadline - Date.now(), 0)));
    }
  }
}

// plugins/memory/source/store.ts
var MAX_STORE_BYTES = 4 * 1024 * 1024;
var MAX_STORE_ENTRIES = 2e3;
function parseEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MemoryStoreError(
      "invalid_memory_store",
      "Memory store contains an invalid entry."
    );
  }
  const record = value;
  if (typeof record.id !== "string" || record.id.trim().length === 0 || typeof record.content !== "string" || record.content.trim().length === 0 || typeof record.createdAt !== "string" || Number.isNaN(Date.parse(record.createdAt))) {
    throw new MemoryStoreError(
      "invalid_memory_store",
      "Memory store contains an invalid entry."
    );
  }
  return Object.freeze({
    id: record.id.trim(),
    content: record.content.trim(),
    createdAt: record.createdAt
  });
}
function parseStore(raw) {
  if (Buffer.byteLength(raw, "utf8") > MAX_STORE_BYTES) {
    throw new MemoryStoreError(
      "memory_store_too_large",
      "Memory store exceeds its configured size limit."
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MemoryStoreError(
      "invalid_memory_store",
      "Memory store is not valid JSON."
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MemoryStoreError(
      "invalid_memory_store",
      "Memory store must be a JSON object."
    );
  }
  const entries = parsed.entries;
  if (!Array.isArray(entries)) {
    throw new MemoryStoreError(
      "invalid_memory_store",
      "Memory store entries must be an array."
    );
  }
  if (entries.length > MAX_STORE_ENTRIES) {
    throw new MemoryStoreError(
      "memory_store_capacity_exceeded",
      "Memory store exceeds its configured entry limit."
    );
  }
  const validated = entries.map(parseEntry);
  const ids = /* @__PURE__ */ new Set();
  for (const entry of validated) {
    if (ids.has(entry.id)) {
      throw new MemoryStoreError(
        "invalid_memory_store",
        "Memory store contains duplicate IDs."
      );
    }
    ids.add(entry.id);
  }
  const derivedNextSequence = nextSequenceAfter(validated);
  const persistedNextSequence = parsed.nextSequence;
  if (persistedNextSequence !== void 0 && (!Number.isSafeInteger(persistedNextSequence) || Number(persistedNextSequence) < derivedNextSequence)) {
    throw new MemoryStoreError(
      "invalid_memory_store",
      "Memory store nextSequence is invalid."
    );
  }
  return Object.freeze({
    entries: Object.freeze(validated),
    nextSequence: persistedNextSequence === void 0 ? derivedNextSequence : Number(persistedNextSequence)
  });
}
function serializeStore(state) {
  return `${JSON.stringify(
    { nextSequence: state.nextSequence, entries: state.entries },
    null,
    2
  )}
`;
}
async function atomicWrite(filePath, state) {
  const temporaryPath = `${filePath}.${process.pid}.${(0, import_node_crypto2.randomUUID)()}.tmp`;
  const serialized = serializeStore(state);
  if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) {
    throw new MemoryStoreError(
      "memory_store_capacity_exceeded",
      "Memory store exceeds its configured size limit."
    );
  }
  try {
    await (0, import_promises2.writeFile)(temporaryPath, serialized, {
      encoding: "utf8",
      mode: 384
    });
    await (0, import_promises2.rename)(temporaryPath, filePath);
  } finally {
    await (0, import_promises2.rm)(temporaryPath, { force: true });
  }
}
function nextSequenceAfter(entries) {
  let maximum = 0;
  for (const entry of entries) {
    const match = /^mem-(\d+)$/u.exec(entry.id);
    if (!match?.[1]) continue;
    const numeric = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(numeric)) maximum = Math.max(maximum, numeric);
  }
  return maximum + 1;
}
function memoryId(sequence) {
  return `mem-${String(sequence).padStart(4, "0")}`;
}
function fileSystemErrorCode2(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : void 0;
}
async function readStoreFile(filePath) {
  const handle = await (0, import_promises2.open)(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new MemoryStoreError(
        "invalid_memory_store",
        "Memory store must be a regular file."
      );
    }
    if (info.size > MAX_STORE_BYTES) {
      throw new MemoryStoreError(
        "memory_store_too_large",
        "Memory store exceeds its configured size limit."
      );
    }
    return parseStore(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}
var MemoryStore = class {
  #filePath;
  #legacyFilePaths;
  #now;
  #initialization;
  #mutationTail = Promise.resolve();
  constructor(options) {
    this.#filePath = options.filePath;
    this.#legacyFilePaths = Object.freeze([...options.legacyFilePaths ?? []]);
    this.#now = options.now ?? (() => /* @__PURE__ */ new Date());
  }
  async #withLock(operation) {
    const release = await acquireStoreLock(this.#filePath);
    try {
      return await operation();
    } finally {
      await release();
    }
  }
  #ensureInitialized() {
    if (this.#initialization) return this.#initialization;
    const initialization = this.#withLock(() => this.#initialize());
    this.#initialization = initialization;
    void initialization.catch(() => {
      if (this.#initialization === initialization) {
        this.#initialization = void 0;
      }
    });
    return initialization;
  }
  async #initialize() {
    await (0, import_promises2.mkdir)((0, import_node_path2.dirname)(this.#filePath), { recursive: true });
    try {
      await (0, import_promises2.access)(this.#filePath);
      return;
    } catch (error) {
      if (fileSystemErrorCode2(error) !== "ENOENT") {
        throw new MemoryStoreError(
          "memory_store_unavailable",
          "Memory store is unavailable."
        );
      }
    }
    for (const legacyPath of this.#legacyFilePaths) {
      try {
        const legacy = await readStoreFile(legacyPath);
        await atomicWrite(this.#filePath, legacy);
        return;
      } catch (error) {
        if (error instanceof MemoryStoreError) throw error;
        if (fileSystemErrorCode2(error) !== "ENOENT") {
          throw new MemoryStoreError(
            "memory_store_unavailable",
            "Memory store is unavailable."
          );
        }
      }
    }
    await atomicWrite(
      this.#filePath,
      Object.freeze({ entries: Object.freeze([]), nextSequence: 1 })
    );
  }
  async #load() {
    await this.#ensureInitialized();
    try {
      return await readStoreFile(this.#filePath);
    } catch (error) {
      if (error instanceof MemoryStoreError) throw error;
      throw new MemoryStoreError(
        "memory_store_unavailable",
        "Memory store is unavailable."
      );
    }
  }
  async read() {
    await this.#mutationTail;
    return this.#load();
  }
  async #mutate(mutation) {
    const operation = this.#mutationTail.then(async () => {
      await this.#ensureInitialized();
      return this.#withLock(async () => {
        const current = await readStoreFile(this.#filePath);
        const next = mutation(current);
        await atomicWrite(this.#filePath, next.state);
        return next.value;
      });
    });
    this.#mutationTail = operation.then(
      () => void 0,
      () => void 0
    );
    return operation;
  }
  add(content) {
    return this.#mutate((current) => {
      if (current.entries.length >= MAX_STORE_ENTRIES) {
        throw new MemoryStoreError(
          "memory_store_capacity_exceeded",
          "Memory store exceeds its configured entry limit."
        );
      }
      const entry = Object.freeze({
        id: memoryId(current.nextSequence),
        content,
        createdAt: this.#now().toISOString()
      });
      return Object.freeze({
        state: Object.freeze({
          entries: Object.freeze([...current.entries, entry]),
          nextSequence: current.nextSequence + 1
        }),
        value: entry
      });
    });
  }
  delete(id) {
    return this.#mutate((current) => {
      const remaining = current.entries.filter((entry) => entry.id !== id);
      return Object.freeze({
        state: Object.freeze({
          entries: Object.freeze(remaining),
          nextSequence: current.nextSequence
        }),
        value: current.entries.length - remaining.length
      });
    });
  }
};

// plugins/memory/source/index.ts
var MAX_MEMORY_CONTENT_LENGTH = 2e3;
var SEARCH_RESULT_LIMIT = 10;
var DEFAULT_PAGE_LIMIT = 50;
var MAX_PAGE_LIMIT = 100;
function memoryFailure(error, operation) {
  if (isMemoryStoreError(error)) {
    return failureResult({ errorCode: error.code, message: error.message });
  }
  return failureFromError(error, {
    fallbackCode: "memory_operation_failed",
    fallbackMessage: "Memory operation failed.",
    operation
  });
}
var index_default = defineRuntimePlugin((context) => {
  const store = new MemoryStore({
    filePath: (0, import_node_path3.join)(context.stateDir, "memory.json"),
    legacyFilePaths: [
      (0, import_node_path3.join)(context.runtimePaths.runtimeDir, "memory", "memory.json"),
      (0, import_node_path3.join)(context.runtimePaths.rootDir, "memory", "memory.json")
    ]
  });
  return {
    handlers: {
      async memory_get(params) {
        try {
          const offset = readBoundedInteger(params.offset, {
            defaultValue: 0,
            minimum: 0,
            maximum: 1e6,
            name: "offset"
          });
          const limit = readBoundedInteger(params.limit, {
            defaultValue: DEFAULT_PAGE_LIMIT,
            minimum: 1,
            maximum: MAX_PAGE_LIMIT,
            name: "limit"
          });
          const state = await store.read();
          const page = state.entries.slice(offset, offset + limit);
          const rendered = renderEntries(page, {
            heading: `Memory entries: ${state.entries.length} (offset ${offset})`,
            totalEntries: Math.max(state.entries.length - offset, 0)
          });
          const nextOffset = offset + rendered.returnedEntries < state.entries.length ? offset + rendered.returnedEntries : void 0;
          return successResult({
            output: rendered.output,
            progress: rendered.returnedEntries > 0,
            producedNewInformation: rendered.returnedEntries > 0,
            data: {
              hasData: rendered.returnedEntries > 0,
              itemCount: state.entries.length,
              returnedItemCount: rendered.returnedEntries,
              offset,
              limit,
              ...nextOffset !== void 0 ? { nextOffset } : {},
              truncated: rendered.truncated,
              outputMaxChars: rendered.outputMaxChars,
              ...rendered.returnedEntries > 0 ? {
                observationMeta: {
                  kind: "stable_fact",
                  carryPolicy: "always"
                }
              } : {}
            }
          });
        } catch (error) {
          return memoryFailure(error, "memory_get");
        }
      },
      async memory_search(params) {
        try {
          const query = readRequiredString(params.query, {
            name: "query",
            maxLength: 4096
          });
          const state = await store.read();
          const result = searchMemory(
            state.entries,
            query,
            SEARCH_RESULT_LIMIT
          );
          const rendered = renderEntries(result.matches, {
            heading: `Search query: ${query}
Memory matches: ${result.totalMatches}`,
            totalEntries: result.totalMatches
          });
          return successResult({
            output: rendered.output,
            progress: rendered.returnedEntries > 0,
            producedNewInformation: rendered.returnedEntries > 0,
            data: {
              hasData: rendered.returnedEntries > 0,
              itemCount: result.totalMatches,
              memoryItemCount: result.totalMatches,
              returnedItemCount: rendered.returnedEntries,
              satisfiedStoredStateLookup: result.totalMatches > 0,
              truncated: rendered.truncated,
              outputMaxChars: rendered.outputMaxChars,
              ...rendered.returnedEntries > 0 ? {
                observationMeta: {
                  kind: "stable_fact",
                  carryPolicy: "always"
                }
              } : {}
            }
          });
        } catch (error) {
          return memoryFailure(error, "memory_search");
        }
      },
      async memory_add(params) {
        try {
          const content = readRequiredString(params.content, {
            name: "content",
            maxLength: MAX_MEMORY_CONTENT_LENGTH
          });
          const entry = await store.add(content);
          return successResult({
            output: [
              "Memory add: success",
              `id: ${entry.id}`,
              `content: ${entry.content}`
            ].join("\n"),
            progress: true,
            producedNewInformation: true,
            actions: [{ type: "memory_add", target: entry.id }],
            data: { mutationEvidence: true, id: entry.id }
          });
        } catch (error) {
          return memoryFailure(error, "memory_add");
        }
      },
      async memory_delete(params) {
        try {
          const id = readRequiredString(params.id, {
            name: "id",
            maxLength: 128
          });
          const deletedCount = await store.delete(id);
          const hasDeletedMemoryEntries = deletedCount > 0;
          return successResult({
            output: [
              `Memory delete: ${hasDeletedMemoryEntries ? "success" : "no_match"}`,
              `id: ${id}`,
              `deleted: ${deletedCount}`,
              ...hasDeletedMemoryEntries ? [] : [
                "No memory entry matched that ID. Retrieve memory before retrying."
              ]
            ].join("\n"),
            progress: hasDeletedMemoryEntries,
            producedNewInformation: hasDeletedMemoryEntries,
            data: {
              ...hasDeletedMemoryEntries ? { mutationEvidence: true } : {},
              deletedCount
            },
            ...hasDeletedMemoryEntries ? {
              actions: [{ type: "memory_delete", target: id }]
            } : {}
          });
        } catch (error) {
          return memoryFailure(error, "memory_delete");
        }
      }
    }
  };
});
